// SCP-G5-E — protected provider portrait storage.
//
// M01: bytes live behind a server-mediated boundary. The browser uploads
// through an authorized route carrying a server-verified session; it never
// holds a storage credential, and there is no publicly writable bucket to make
// authoritative — the authoritative database the runtime already verifies at
// startup is also what stores the portrait.
//
// M02: media storage owns BYTES ONLY. There is no column here that could carry
// approval, and the reference points from profile to media rather than the
// other way round, so replacing or losing a portrait cannot move a Provider's
// supply status. The content type is validated by inspecting the magic bytes
// rather than trusting a declared header.
//
// Storing image bytes in PostgreSQL is a deliberate bounded choice for this
// gate: it introduces no new platform dependency, needs no credential the
// runtime does not already hold, and is durable across restart. Selecting a
// production object-storage backend is recorded as a residual rather than
// smuggled in here.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { IdentityLineage } from "../runtime/identity";
import { recordRuntimeEvidence } from "../runtime/evidence";

export const ACCEPTED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AcceptedMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

/** 5 MiB, matching the database constraint. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/**
 * Identifies an image from its leading bytes. A declared `content-type` is a
 * claim by the uploader; the magic bytes are the file.
 */
export function sniffImageType(bytes: Buffer): AcceptedMediaType | null {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    return null;
}

export interface StoredMedia {
    mediaId: string;
    providerId: string;
    contentType: AcceptedMediaType;
    byteSize: number;
    sha256: string;
}

export type MediaFailure = "MEDIA_TYPE_UNSUPPORTED" | "MEDIA_TOO_LARGE";

export type MediaOutcome =
    | { ok: true; media: StoredMedia }
    | { ok: false; code: MediaFailure; message: string };

export async function storeProviderPortrait(
    client: PoolClient,
    input: {
        providerId: string;
        lineage: IdentityLineage;
        uploadedByIdentityId: string;
        bytes: Buffer;
        configurationVersion: number;
        configurationChecksum: string;
        correlationId: string;
    }
): Promise<MediaOutcome> {
    if (input.bytes.length === 0 || input.bytes.length > MAX_MEDIA_BYTES) {
        return {
            ok: false,
            code: "MEDIA_TOO_LARGE",
            message: `a portrait must be between 1 byte and ${MAX_MEDIA_BYTES} bytes`
        };
    }
    const contentType = sniffImageType(input.bytes);
    if (contentType === null) {
        return {
            ok: false,
            code: "MEDIA_TYPE_UNSUPPORTED",
            message: `a portrait must be one of ${ACCEPTED_MEDIA_TYPES.join(", ")}`
        };
    }

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const { rows } = await client.query<{ media_id: string }>(
        `INSERT INTO core_provider_media
            (provider_id, tenant_id, market_id, environment, content_type, byte_size, sha256,
             bytes, uploaded_by_identity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING media_id`,
        [
            input.providerId,
            input.lineage.tenantId,
            input.lineage.marketId,
            input.lineage.environment,
            contentType,
            input.bytes.length,
            sha256,
            input.bytes,
            input.uploadedByIdentityId
        ]
    );
    const mediaId = rows[0]!.media_id;

    await recordRuntimeEvidence(client, {
        kind: "PROVIDER_MEDIA_STORED",
        lineage: input.lineage,
        outcome: "OK",
        configurationVersion: input.configurationVersion,
        configurationChecksum: input.configurationChecksum,
        detail: {
            correlationId: input.correlationId,
            providerId: input.providerId,
            mediaId,
            contentType,
            byteSize: input.bytes.length,
            sha256,
            // Stated in the record: bytes are bytes. Storing one approves nothing.
            affectsProviderApproval: false
        }
    });

    return {
        ok: true,
        media: {
            mediaId,
            providerId: input.providerId,
            contentType,
            byteSize: input.bytes.length,
            sha256
        }
    };
}

export interface MediaBytes {
    contentType: string;
    bytes: Buffer;
    sha256: string;
}

/**
 * Reads a portrait, scoped to the requesting tenant/market/environment AND to
 * the provider it belongs to. There is no unscoped read path, so a media id
 * guessed or copied from another tenant resolves to nothing.
 */
export async function readProviderPortrait(
    client: PoolClient,
    lineage: IdentityLineage,
    providerId: string,
    mediaId: string
): Promise<MediaBytes | null> {
    const { rows } = await client.query<{
        content_type: string;
        bytes: Buffer;
        sha256: string;
    }>(
        `SELECT content_type, bytes, sha256 FROM core_provider_media
          WHERE media_id = $1 AND provider_id = $2
            AND tenant_id = $3 AND market_id = $4 AND environment = $5`,
        [mediaId, providerId, lineage.tenantId, lineage.marketId, lineage.environment]
    );
    const row = rows[0];
    return row ? { contentType: row.content_type, bytes: row.bytes, sha256: row.sha256 } : null;
}
