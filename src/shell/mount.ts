// C2 — mount table for the Experience Lab.
//
// The hosts route on absolute paths they already own (`/`, `/healthz`,
// `/api/customer/requests`, `/api/partner/*`, `/api/operations/*`). Mounting them
// under `/labs/freshline` therefore means stripping the mount prefix before
// delegating, so each handler sees exactly the paths it was written for.
//
// This is a pure transport translation and nothing else. No route is renamed, no
// method is reinterpreted, no body is touched. The alternative — teaching every
// host about a `/labs` prefix — would push Experience Lab knowledge into proven
// code for no benefit.

/** Rewrites `req.url` so a mounted handler sees its own path space. */
export function stripMountPrefix(url: string, prefix: string): string {
    const [rawPath = "/", ...rest] = url.split("?");
    const query = rest.length > 0 ? `?${rest.join("?")}` : "";

    if (rawPath === prefix) {
        // `/labs/freshline` is that host's root, not a missing page.
        return `/${query}`;
    }
    if (rawPath.startsWith(`${prefix}/`)) {
        const remainder = rawPath.slice(prefix.length);
        return `${remainder === "" ? "/" : remainder}${query}`;
    }
    return url;
}

export type MountPerspective = "DEMAND" | "SUPPLY" | "OPERATE";

export interface LabMount {
    /** Path prefix under `/labs`. Longest prefix wins, so order is not load-bearing. */
    prefix: string;
    tenant: string;
    perspective: MountPerspective;
    /** Which extracted host handler serves it, or `SHELL` for Shell-rendered tenants. */
    handler: "CUSTOMER" | "PARTNER" | "OWNER" | "SHELL";
}

/**
 * Freshline is served by its own proven handlers — REAL WHERE PROVEN. Athena has
 * no live SCP capability behind it, so it is Shell-rendered from an explicitly
 * marked fixture provider.
 *
 * `/labs/freshline/partner` and `/labs/freshline/operate` are listed before the
 * bare Freshline prefix would swallow them; selection uses longest-match so the
 * table stays readable rather than order-dependent.
 */
export const LAB_MOUNTS: readonly LabMount[] = [
    { prefix: "/labs/freshline/partner", tenant: "freshline-uat", perspective: "SUPPLY", handler: "PARTNER" },
    { prefix: "/labs/freshline/operate", tenant: "freshline-uat", perspective: "OPERATE", handler: "OWNER" },
    { prefix: "/labs/freshline", tenant: "freshline-uat", perspective: "DEMAND", handler: "CUSTOMER" },
    { prefix: "/labs/athena/operate", tenant: "athena-uat", perspective: "OPERATE", handler: "SHELL" },
    { prefix: "/labs/athena", tenant: "athena-uat", perspective: "DEMAND", handler: "SHELL" }
];

/** Longest-prefix match, so `/labs/freshline/operate` never resolves to DEMAND. */
export function resolveMount(pathname: string): LabMount | undefined {
    let best: LabMount | undefined;
    for (const mount of LAB_MOUNTS) {
        const matches = pathname === mount.prefix || pathname.startsWith(`${mount.prefix}/`);
        if (matches && (best === undefined || mount.prefix.length > best.prefix.length)) {
            best = mount;
        }
    }
    return best;
}
