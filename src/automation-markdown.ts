import MarkdownIt from "markdown-it";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
});

markdown.validateLink = (href: string): boolean => {
  if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return false;
  try {
    const url = new URL(href);
    return ALLOWED_PROTOCOLS.has(url.protocol) && (url.protocol === "mailto:" || Boolean(url.hostname));
  } catch {
    return false;
  }
};

markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export function renderAutomationMarkdown(source: string): string {
  return markdown.render(source);
}
