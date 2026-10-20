use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

const CONSENT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const DENIED_MESSAGE: &str =
    "Saved sudo password use was denied for this run. Start a new run to ask again.";
const BLOCKED_MESSAGE: &str = "Saved sudo password use is disabled for this run. Check the saved password and start a new run.";

#[derive(Default)]
enum ConsentState {
    #[default]
    Unasked,
    Pending {
        request_id: String,
        deadline: Instant,
    },
    Allowed,
    Denied,
    Blocked,
}

#[derive(Default)]
pub(crate) struct SudoConsent {
    state: Mutex<ConsentState>,
    changed: Condvar,
}

impl SudoConsent {
    pub(crate) fn authorize_with(
        &self,
        request_id: &str,
        timeout: Duration,
        check_active: impl Fn() -> Result<(), String>,
        notify: impl Fn(&str, &str, &str) -> Result<(), String>,
    ) -> Result<(), String> {
        check_active()?;
        let owns_request = {
            let mut state = self.state.lock().map_err(|_| "Sudo consent lock failed")?;
            match &*state {
                ConsentState::Allowed => return Ok(()),
                ConsentState::Denied => return Err(DENIED_MESSAGE.to_string()),
                ConsentState::Blocked => return Err(BLOCKED_MESSAGE.to_string()),
                ConsentState::Pending { .. } => false,
                ConsentState::Unasked => {
                    *state = ConsentState::Pending {
                        request_id: request_id.to_string(),
                        deadline: Instant::now() + timeout,
                    };
                    true
                }
            }
        };
        let decision = (|| {
            if owns_request {
                notify(
                    "sudo_approval",
                    request_id,
                    "This permission ends when the run stops or completes.",
                )?;
            }
            loop {
                check_active()?;
                let mut state = self.state.lock().map_err(|_| "Sudo consent lock failed")?;
                match &*state {
                    ConsentState::Allowed => return check_active(),
                    ConsentState::Denied => return Err(DENIED_MESSAGE.to_string()),
                    ConsentState::Blocked => return Err(BLOCKED_MESSAGE.to_string()),
                    ConsentState::Pending { deadline, .. } if Instant::now() >= *deadline => {
                        *state = ConsentState::Denied;
                        self.changed.notify_all();
                        return Err(
                            "Sudo consent expired. Start a new run to ask again.".to_string()
                        );
                    }
                    ConsentState::Pending { .. } => {
                        drop(
                            self.changed
                                .wait_timeout(state, CONSENT_POLL_INTERVAL)
                                .map_err(|_| "Sudo consent lock failed")?,
                        );
                    }
                    ConsentState::Unasked => {
                        return Err("Sudo consent is no longer active".to_string())
                    }
                }
            }
        })();
        if owns_request {
            let mut state = self.state.lock().map_err(|_| "Sudo consent lock failed")?;
            if matches!(&*state, ConsentState::Pending { request_id: pending, .. } if pending == request_id)
            {
                *state = ConsentState::Denied;
                self.changed.notify_all();
            }
            drop(state);
            let notification = match &decision {
                Ok(()) => notify(
                    "sudo_status",
                    request_id,
                    "Saved sudo password allowed for this run.",
                ),
                Err(error) => notify("sudo_error", request_id, error),
            };
            if let Err(error) = notification {
                self.block()?;
                return Err(error);
            }
        }
        decision
    }

    pub(crate) fn respond(&self, request_id: &str, approved: bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Sudo consent lock failed")?;
        match &*state {
            ConsentState::Pending {
                request_id: pending,
                deadline,
            } if pending == request_id && Instant::now() < *deadline => {}
            _ => return Err("Sudo consent expired or was already answered".to_string()),
        }
        *state = if approved {
            ConsentState::Allowed
        } else {
            ConsentState::Denied
        };
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn block(&self) -> Result<(), String> {
        *self.state.lock().map_err(|_| "Sudo consent lock failed")? = ConsentState::Blocked;
        self.changed.notify_all();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    #[test]
    fn consent_is_requested_once_and_reused_only_after_explicit_allow() {
        let consent = SudoConsent::default();
        let requests = AtomicUsize::new(0);
        for id in ["first", "second"] {
            consent
                .authorize_with(
                    id,
                    TEST_TIMEOUT,
                    || Ok(()),
                    |kind, request, _| {
                        if kind == "sudo_approval" {
                            requests.fetch_add(1, Ordering::SeqCst);
                            assert!(consent.respond("stale", true).is_err());
                            consent.respond(request, true)?;
                            assert!(consent.respond(request, true).is_err());
                        }
                        Ok(())
                    },
                )
                .unwrap();
        }
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(consent.respond("first", false).is_err());
    }

    #[test]
    fn denied_consent_and_blocked_credentials_cannot_reprompt() {
        let denied = SudoConsent::default();
        assert!(denied
            .authorize_with(
                "first",
                TEST_TIMEOUT,
                || Ok(()),
                |kind, id, _| {
                    if kind == "sudo_approval" {
                        denied.respond(id, false)?;
                    }
                    Ok(())
                }
            )
            .is_err());
        assert!(denied
            .authorize_with(
                "second",
                TEST_TIMEOUT,
                || Ok(()),
                |_, _, _| panic!("must not reprompt")
            )
            .is_err());
        let blocked = SudoConsent::default();
        blocked.block().unwrap();
        assert!(blocked
            .authorize_with(
                "first",
                TEST_TIMEOUT,
                || Ok(()),
                |_, _, _| panic!("must not prompt")
            )
            .unwrap_err()
            .contains("disabled"));
    }

    #[test]
    fn expired_requests_reject_responses_and_report_resolution() {
        let consent = SudoConsent::default();
        let events = Mutex::new(Vec::new());
        assert!(consent
            .authorize_with(
                "expired",
                Duration::ZERO,
                || Ok(()),
                |kind, id, _| {
                    events.lock().unwrap().push(kind.to_string());
                    assert!(consent.respond(id, true).is_err());
                    Ok(())
                }
            )
            .unwrap_err()
            .contains("expired"));
        assert_eq!(*events.lock().unwrap(), ["sudo_approval", "sudo_error"]);
    }

    #[test]
    fn cancellation_and_notification_failure_do_not_allow_credentials() {
        for fail_notification in [false, true] {
            let consent = SudoConsent::default();
            let active = AtomicBool::new(true);
            assert!(consent
                .authorize_with(
                    "request",
                    TEST_TIMEOUT,
                    || {
                        if active.load(Ordering::SeqCst) {
                            Ok(())
                        } else {
                            Err("Cancelled".to_string())
                        }
                    },
                    |kind, _, _| {
                        if kind == "sudo_approval" {
                            if fail_notification {
                                return Err("Event delivery failed".to_string());
                            }
                            active.store(false, Ordering::SeqCst);
                        }
                        Ok(())
                    }
                )
                .is_err());
            assert!(consent.respond("request", true).is_err());
            assert!(consent
                .authorize_with(
                    "next",
                    TEST_TIMEOUT,
                    || Ok(()),
                    |_, _, _| panic!("must not reprompt")
                )
                .is_err());
        }
    }

    #[test]
    fn concurrent_callers_share_the_same_pending_decision() {
        let consent = Arc::new(SudoConsent::default());
        let (requested, request) = mpsc::channel();
        let first = Arc::clone(&consent);
        let thread = std::thread::spawn(move || {
            first.authorize_with(
                "first",
                TEST_TIMEOUT,
                || Ok(()),
                |kind, id, _| {
                    if kind == "sudo_approval" {
                        requested.send(id.to_string()).unwrap();
                    }
                    Ok(())
                },
            )
        });
        let id = request.recv_timeout(TEST_TIMEOUT).unwrap();
        let second = Arc::clone(&consent);
        let waiter = std::thread::spawn(move || {
            second.authorize_with(
                "second",
                TEST_TIMEOUT,
                || Ok(()),
                |_, _, _| panic!("must share the existing request"),
            )
        });
        consent.respond(&id, true).unwrap();
        thread.join().unwrap().unwrap();
        waiter.join().unwrap().unwrap();
        consent.block().unwrap();
        assert!(consent
            .authorize_with("next", TEST_TIMEOUT, || Ok(()), |_, _, _| panic!("blocked"))
            .is_err());
    }

    #[test]
    fn authorization_rechecks_cancellation_after_acceptance() {
        let consent = SudoConsent::default();
        let active = AtomicBool::new(true);
        assert!(consent
            .authorize_with(
                "request",
                TEST_TIMEOUT,
                || {
                    if active.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err("Cancelled".to_string())
                    }
                },
                |kind, id, _| {
                    if kind == "sudo_approval" {
                        consent.respond(id, true)?;
                        active.store(false, Ordering::SeqCst);
                    }
                    Ok(())
                }
            )
            .is_err());
    }
}
