mod commands;
mod automation;
mod automation_mcp;
mod automation_provider;
mod automation_sessions;
mod automation_ssh;
mod automation_sudo_consent;
mod connection;
mod local_terminal;
mod ssh_security;
mod vpn;

use connection::SshConnection;
use local_terminal::LocalTerminal;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub type DbSessionMap = Mutex<HashMap<String, SshConnection>>;
pub(crate) type LocalTerminalMap = Mutex<HashMap<String, LocalTerminal>>;
pub type VpnProcessState = Arc<Mutex<Option<u32>>>;

const GLOBAL_TERMINAL_SHORTCUT: &str = "Ctrl+Alt+T";
const OPEN_LOCAL_TERMINAL_EVENT: &str = "open-local-terminal";

#[cfg(desktop)]
fn activate_terminal_shortcut(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::AssetNotFound("Main window was not found".to_string()))?;

    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
    app.emit(OPEN_LOCAL_TERMINAL_EVENT, ())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(automation_mcp::BRIDGE_ARGUMENT)) {
        if let Err(error) = automation_mcp::run_stdio_bridge() {
            eprintln!("SleekSSH automation bridge: {error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .manage(automation::AutomationState::default())
        .manage(Mutex::new(HashMap::<String, SshConnection>::new()))
        .manage(Mutex::new(HashMap::<String, LocalTerminal>::new()))
        .manage(Arc::new(Mutex::new(None::<u32>)))
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Err(error) = automation::shutdown(&window.state::<automation::AutomationState>()) {
                    eprintln!("Cannot stop automation while closing SleekSSH: {error}");
                }
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

                app.handle()
                    .plugin(tauri_plugin_autostart::Builder::new().build())?;
                if let Err(error) = app.autolaunch().enable() {
                    eprintln!("Failed to enable startup registration: {error}");
                }

                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
                if let Err(error) = app.global_shortcut().on_shortcut(
                    GLOBAL_TERMINAL_SHORTCUT,
                    |app, _, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }

                        if let Err(error) = activate_terminal_shortcut(app) {
                            eprintln!("Failed to open the local terminal from the global shortcut: {error}");
                        }
                    },
                ) {
                    eprintln!("Failed to register {GLOBAL_TERMINAL_SHORTCUT}: {error}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            automation::list_automation_providers,
            automation::start_ssh_automation,
            automation::stop_ssh_automation,
            automation::respond_automation_approval,
            automation::respond_automation_sudo_consent,
            automation_sessions::list_local_agent_sessions,
            commands::select_key_file,
            commands::get_default_ssh_keys,
            commands::generate_new_ssh_key,
            commands::load_connections,
            commands::save_connections,
            commands::save_sudo_password,
            commands::delete_sudo_password,
            commands::send_sudo_password,
            commands::trust_ssh_host,
            commands::connect_ssh,
            commands::write_ssh,
            commands::resize_ssh,
            commands::disconnect_ssh,
            commands::sftp_list_directory,
            commands::sftp_resolve_path,
            commands::sftp_download_file,
            commands::sftp_upload_file,
            commands::sftp_create_directory,
            commands::sftp_delete_file,
            commands::sftp_delete_directory,
            commands::select_download_destination,
            commands::select_upload_file,
            commands::list_listening_ports,
            commands::kill_port_process,
            local_terminal::start_local_terminal,
            local_terminal::validate_local_terminal_directory,
            local_terminal::select_local_terminal_directory,
            local_terminal::write_local_terminal,
            local_terminal::resize_local_terminal,
            local_terminal::stop_local_terminal,
            vpn::get_vpncli_path,
            vpn::load_vpn_profiles,
            vpn::save_vpn_profiles,
            vpn::list_cisco_vpn_profiles,
            vpn::vpn_status,
            vpn::disconnect_vpn,
            vpn::cancel_vpn_operation,
            vpn::switch_vpn_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
