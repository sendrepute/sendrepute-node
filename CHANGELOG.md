# Changelog

## 0.1.1

- Classify all displayed in-memory plain-text and HTML Nodemailer bodies and
  alternatives together in one bounded request.
- Reject unsupported, malformed, or oversized displayed content in blocking
  mode; advisory mode reports the unsupported content and preserves delivery
  without making a partial paid request.
- Preserve the original message, recipients, attachments, and transport while
  using one adapter classification request for multipart inspection (normal
  configured client retries can still occur).

## 0.1.0

- Initial typed Node.js SDK and optional Nodemailer adapter.