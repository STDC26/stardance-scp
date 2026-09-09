// SCP-RUNTIME-Q01B — qualification entrypoint dispatcher.
//
// Railway's builder did not honour a per-service start command, so role is
// selected by environment variable instead. The default is the command runtime,
// which means the preserved candidate's behaviour is unchanged whether or not
// Q01B_ROLE is set — nothing about the candidate depends on this dispatch.
const role = process.env["Q01B_ROLE"] ?? "runtime";
if (role === "irf-bridge") {
    void import("./irfExecutor");
} else {
    void import("./runtime");
}
