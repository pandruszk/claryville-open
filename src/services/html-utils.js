// Convert an HTML email body to readable plain text. Used when an inbound
// message arrives with no plain-text alternative (Apple Mail, some Outlook
// configurations). Idempotent — input without tags or entities is returned
// essentially unchanged.
function htmlToText(input) {
  if (!input) return '';

  return input
    // Drop comments, style, and script blocks entirely
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Preserve structural breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    // Strip remaining HTML tags. Match only things that look like real tags
    // (start with a letter or '/') — leaves plain-text <email@x.com> alone,
    // which email clients often use in visible "Name <addr>" recipient lists.
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    // Tidy whitespace
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { htmlToText };
