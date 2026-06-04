// Husky bootstrap, run by the `prepare` lifecycle script.
//
// Sets up git hooks in local dev only. Must be a no-op in CI and in
// production image builds: `npm ci --omit=dev` skips devDependencies, so the
// `husky` binary isn't present and a bare `husky` call aborts the Docker
// build with "husky: not found" (exit 127). The early return + try/catch
// make this safe whether or not NODE_ENV is set in the build stage.
if (process.env.NODE_ENV === 'production' || process.env.CI) {
    process.exit(0);
}
try {
    const husky = (await import('husky')).default;
    husky();
} catch {
    // husky not installed (production-only deps) — nothing to set up.
}
