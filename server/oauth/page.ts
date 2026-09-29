// Minimal HTML shell for the OAuth verification pages (server-rendered;
// the app has no view layer on this surface).

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e8eaf0;
         display: flex; justify-content: center; padding: 48px 16px; margin: 0; }
  main { max-width: 440px; width: 100%; background: #171a21; border: 1px solid #2a2e3a;
         border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #aab0c0; line-height: 1.5; }
  ul { padding-left: 20px; color: #aab0c0; }
  code { background: #0f1115; padding: 2px 8px; border-radius: 6px; font-size: 18px;
         letter-spacing: 2px; }
  input[type=text] { width: 100%; box-sizing: border-box; font-size: 18px; padding: 10px 12px;
         letter-spacing: 2px; text-transform: uppercase; background: #0f1115; color: #e8eaf0;
         border: 1px solid #2a2e3a; border-radius: 8px; margin: 12px 0; }
  .row { display: flex; gap: 12px; margin-top: 16px; }
  button { flex: 1; font-size: 16px; padding: 12px; border: none; border-radius: 8px; cursor: pointer; }
  .approve { background: #4f8ff7; color: #fff; }
  .deny { background: #2a2e3a; color: #e8eaf0; }
  .single { width: 100%; background: #4f8ff7; color: #fff; }
  .error { color: #f77; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export { esc };
