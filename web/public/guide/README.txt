Reference captures use real Mergeron UI components and synthetic sample data.
No private project, account, filesystem path or conversation is captured.
FR and EN assets: tasks-*.png and deliverables-*.png.
Regenerate when their controls change; see web/src/routes/guide-captures.browser.tsx.
With Playwright Chromium and WebKit installed, from the repository root:
VITE_CAPTURE_GUIDE=1 pnpm --dir web test:browser src/routes/guide-captures.browser.tsx
Capture generation is opt-in; ordinary browser tests do not overwrite these assets.
