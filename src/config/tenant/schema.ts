// SCP Tenant Configuration — closed schema.
//
// CORR-01. The previous control was a denylist of substrings, and DTS proved it
// exactly as fragile as a denylist always is: `commitmentStrength`,
// `inferredConfidence` and `learningQuality` all sailed through because nobody
// had thought of those particular words. A denylist can only reject what its
// author already imagined.
//
// This is the inversion. Every governed field is DECLARED. Anything not
// declared is rejected wherever it appears and at any depth, so the control no
// longer depends on predicting the name an inferred-state field might use. The
// prohibited-token check is retained in validate.ts as defense-in-depth, but it
// is no longer the semantic control.
//
// Adding a legitimate field is a deliberate schema change with a version bump —
// which is the governance property we want, not an obstacle.

export type SchemaNode =
    | { kind: "object"; fields: Record<string, SchemaNode>; optional?: boolean; nullable?: boolean }
    /** Open key set, constrained value type. For declared vocabularies only. */
    | { kind: "map"; value: SchemaNode; optional?: boolean }
    | { kind: "array"; item: SchemaNode; optional?: boolean }
    | { kind: "string"; enum?: readonly string[]; nullable?: boolean; optional?: boolean }
    | { kind: "number"; optional?: boolean }
    | { kind: "boolean"; optional?: boolean };

const str = (extra: Partial<Extract<SchemaNode, { kind: "string" }>> = {}): SchemaNode => ({
    kind: "string",
    ...extra
});
const num = (): SchemaNode => ({ kind: "number" });
const bool = (): SchemaNode => ({ kind: "boolean" });
const obj = (fields: Record<string, SchemaNode>, optional = false): SchemaNode => ({
    kind: "object",
    fields,
    ...(optional ? { optional: true } : {})
});

const PRICE = obj({
    amount: num(),
    currency: str()
});

/**
 * Values a projection boundary may declare. A closed vocabulary is what stops
 * `projectionBoundaries` becoming a place to smuggle an authority grant.
 */
export const PROJECTION_BOUNDARY_VALUES = [
    "ALLOWED_NON_AUTHORITATIVE_PROJECTION",
    "FUTURE_GOVERNED_EVIDENCE_INTERPRETATION_ONLY",
    "NOT_PERMITTED"
] as const;

export const TENANT_CONFIGURATION_SCHEMA: SchemaNode = obj({
    _meta: obj(
        {
            artifact: str(),
            purpose: str(),
            ccSuppliedValues: { kind: "array", item: str() },
            notCarriedForward: { kind: "array", item: str() }
        },
        true
    ),
    schemaVersion: str(),
    configurationVersion: num(),
    environment: str(),

    tenant: obj({
        id: str(),
        organization: str(),
        brand: str(),
        market: str(),
        status: str()
    }),

    planes: obj({
        BRAND: obj({
            name: str(),
            publicName: str(),
            marketDescriptor: str(),
            tagline: str(),
            design: obj({
                headingFont: str(),
                bodyFont: str(),
                // Open key set (brands name their own colors) but values are
                // constrained to strings; no structure can hide here.
                colors: { kind: "map", value: str() }
            })
        }),

        MARKET: obj({
            id: str(),
            country: str(),
            timezone: str(),
            localeDefault: str(),
            supportedLocales: { kind: "array", item: str() },
            currency: obj({ price: str(), display: str() }),
            operatingHours: obj({
                daily: obj({ open: str(), close: str() })
            }),
            coverage: obj({
                regions: { kind: "array", item: str() },
                customerContext: obj({
                    accommodationTypes: { kind: "array", item: str() }
                })
            })
        }),

        CATALOGUE: obj({
            services: {
                kind: "array",
                item: obj({
                    code: str(),
                    name: str(),
                    price: PRICE,
                    durationMinutes: num(),
                    active: bool()
                })
            },
            extras: {
                kind: "array",
                item: obj({
                    code: str(),
                    name: str(),
                    price: PRICE,
                    extraDurationMinutes: num(),
                    active: bool()
                })
            }
        }),

        COMMERCE: obj({
            locationDynamicPricing: obj({
                prepared: bool(),
                active: bool(),
                // Deliberately declared with NO permitted fields. Dynamic
                // pricing is inactive, so the list must be empty; activating it
                // requires declaring the rule shape in a new schema version
                // rather than letting arbitrary content in today.
                rules: { kind: "array", item: obj({}) }
            }),
            payment: obj({
                capability: str({ enum: ["READY", "NOT_READY"] }),
                active: bool(),
                policy: str({ enum: ["OFFLINE", "ONLINE", "DEFERRED"] }),
                processorAdapter: obj({ configured: bool(), contractReserved: bool() }),
                platformFeePolicy: obj({ shapeReserved: bool(), active: bool() }),
                currencies: obj({
                    priceCurrency: str(),
                    displayCurrency: str(),
                    chargeCurrency: str({ nullable: true }),
                    settlementCurrency: str({ nullable: true })
                }),
                financialAuditBoundary: obj({ required: bool() })
            })
        }),

        OPERATIONS: obj({
            provider: obj({
                approvalRequired: bool(),
                ownerConfirmedAvailabilityRequired: bool(),
                strictEligibilityRequired: bool()
            }),
            lifecycle: obj({
                ownerQualificationRequired: bool(),
                providerAcceptanceDoesNotAssign: bool(),
                ownerAssignmentRequired: bool(),
                customerConfirmationSeparate: bool()
            }),
            scheduling: obj({
                weekStartsOn: str(),
                nonOverlapRequired: bool()
            }),
            recovery: obj({
                noMatchRecoveryEnabled: bool(),
                reassignmentSupported: bool(),
                amendmentRequiredForCustomerCommitmentChange: bool()
            })
        }),

        EXPERIENCE: obj({
            providerExperience: obj({
                canonicalAggregateTerm: str({ enum: ["PROVIDER"] }),
                tenantExperienceTerm: str(),
                displayIdPrefixes: { kind: "map", value: str() },
                ratingCommission: obj({
                    state: str({ enum: ["UNRESOLVED", "RESOLVED"] }),
                    active: bool()
                })
            }),
            customer: obj({
                mobileFirst: bool(),
                regionSelection: str(),
                preferredTimeSelection: str(),
                whatsappEnabled: bool()
            }),
            provider: obj({
                bilingual: obj({ default: str(), supported: { kind: "array", item: str() } }),
                cognitionChips: bool(),
                availabilityChips: bool(),
                vicinityChips: bool(),
                applyToAllDays: bool()
            }),
            owner: obj({
                approvalWorkflows: bool(),
                coverageView: bool(),
                lifecycleCommandView: bool()
            }),
            channels: obj({
                whatsapp: obj({
                    enabled: bool(),
                    authoritativeStateOwner: bool(),
                    adapterRequired: bool()
                })
            })
        })
    }),

    measurement: obj({
        canonicalSource: str({ enum: ["SCP_EVENTS_AND_RECORDS"] }),
        lineage: obj({ tenantRequired: bool(), marketRequired: bool() }),
        reporting: obj({ mayCreateProjections: bool(), mayOwnBusinessTruth: bool() }),
        // Explicitly permitted CLAD-boundary declarations. Open key set so new
        // projections can be named, but each value must come from the closed
        // vocabulary — a boundary declaration can never become a grant.
        projectionBoundaries: {
            kind: "map",
            value: str({ enum: PROJECTION_BOUNDARY_VALUES })
        },
        cladConstraints: obj({
            cladSpecificInferredStatesInScpCore: bool(),
            psychologicalProfileFields: bool(),
            transactionalAuthority: bool()
        })
    })
});

/**
 * G5-C schema v2. Identical to v1 except that the tenant MARKET plane no longer
 * declares timezone, currency or operating hours — the canonical SCP market
 * plane owns those — and the COMMERCE payment block no longer restates
 * price/display currency. A duplicate authoritative value is therefore
 * unrepresentable rather than merely rejected.
 */
export const TENANT_CONFIGURATION_SCHEMA_V2: SchemaNode = (() => {
    const v1 = TENANT_CONFIGURATION_SCHEMA as Extract<SchemaNode, { kind: "object" }>;
    const planesV1 = v1.fields["planes"] as Extract<SchemaNode, { kind: "object" }>;
    const commerceV1 = planesV1.fields["COMMERCE"] as Extract<SchemaNode, { kind: "object" }>;
    const paymentV1 = commerceV1.fields["payment"] as Extract<SchemaNode, { kind: "object" }>;

    return {
        kind: "object",
        fields: {
            ...v1.fields,
            planes: {
                kind: "object",
                fields: {
                    ...planesV1.fields,
                    MARKET: {
                        kind: "object",
                        fields: {
                            id: { kind: "string" },
                            country: { kind: "string" },
                            localeDefault: { kind: "string" },
                            supportedLocales: { kind: "array", item: { kind: "string" } },
                            marketConfigurationRef: { kind: "string" },
                            approvedOverrides: {
                                kind: "object",
                                fields: {
                                    operatingHours: {
                                        kind: "object",
                                        nullable: true,
                                        fields: {
                                            daily: {
                                                kind: "object",
                                                fields: {
                                                    open: { kind: "string" },
                                                    close: { kind: "string" }
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            coverage: {
                                kind: "object",
                                fields: {
                                    regions: { kind: "array", item: { kind: "string" } },
                                    customerContext: {
                                        kind: "object",
                                        fields: {
                                            accommodationTypes: {
                                                kind: "array",
                                                item: { kind: "string" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    COMMERCE: {
                        kind: "object",
                        fields: {
                            ...commerceV1.fields,
                            payment: {
                                kind: "object",
                                fields: {
                                    ...paymentV1.fields,
                                    currencies: {
                                        kind: "object",
                                        fields: {
                                            chargeCurrency: { kind: "string", nullable: true },
                                            settlementCurrency: { kind: "string", nullable: true }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
})();

/** Selects the closed schema for a declared bundle schema version. */
export function schemaForVersion(schemaVersion: unknown): SchemaNode | null {
    if (schemaVersion === "scp.tenant.configuration.v1") return TENANT_CONFIGURATION_SCHEMA;
    if (schemaVersion === "scp.tenant.configuration.v2") return TENANT_CONFIGURATION_SCHEMA_V2;
    return null;
}

export interface SchemaViolation {
    code: "UNDECLARED_FIELD" | "MISSING_REQUIRED_FIELD" | "FIELD_TYPE_INVALID" | "VALUE_NOT_PERMITTED";
    path: string;
    message: string;
}

/**
 * Walks a bundle against the closed schema. Any field the schema does not
 * declare is a violation wherever it appears and however deeply it is nested.
 */
export function checkAgainstSchema(value: unknown, schema: SchemaNode = TENANT_CONFIGURATION_SCHEMA): SchemaViolation[] {
    const violations: SchemaViolation[] = [];
    walk(value, schema, "", violations);
    return violations;
}

function walk(value: unknown, schema: SchemaNode, path: string, out: SchemaViolation[]): void {
    const at = path || "(root)";

    switch (schema.kind) {
        case "object": {
            if (value === null && schema.nullable) {
                return;
            }
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "expected an object" });
                return;
            }
            const record = value as Record<string, unknown>;
            for (const key of Object.keys(record)) {
                const child = schema.fields[key];
                if (!child) {
                    out.push({
                        code: "UNDECLARED_FIELD",
                        path: `${path ? `${path}.` : ""}${key}`,
                        message: `field "${key}" is not declared in the governed configuration schema; undeclared fields are rejected so that inferred, derived or profiling state cannot enter Core configuration`
                    });
                    continue;
                }
                walk(record[key], child, `${path ? `${path}.` : ""}${key}`, out);
            }
            for (const [key, child] of Object.entries(schema.fields)) {
                if (child.optional) continue;
                if (!(key in record)) {
                    out.push({
                        code: "MISSING_REQUIRED_FIELD",
                        path: `${path ? `${path}.` : ""}${key}`,
                        message: `required field "${key}" is missing`
                    });
                }
            }
            return;
        }
        case "map": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "expected an object map" });
                return;
            }
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                walk(child, schema.value, `${path ? `${path}.` : ""}${key}`, out);
            }
            return;
        }
        case "array": {
            if (!Array.isArray(value)) {
                out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "expected an array" });
                return;
            }
            value.forEach((item, i) => walk(item, schema.item, `${path}[${i}]`, out));
            return;
        }
        case "string": {
            if (value === null) {
                if (!schema.nullable) {
                    out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "null is not permitted" });
                }
                return;
            }
            if (typeof value !== "string") {
                out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "expected a string" });
                return;
            }
            if (schema.enum && !schema.enum.includes(value)) {
                out.push({
                    code: "VALUE_NOT_PERMITTED",
                    path: at,
                    message: `"${value}" is not one of [${schema.enum.join(", ")}]`
                });
            }
            return;
        }
        case "number": {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "expected a number" });
            }
            return;
        }
        case "boolean": {
            if (typeof value !== "boolean") {
                out.push({ code: "FIELD_TYPE_INVALID", path: at, message: "expected a boolean" });
            }
            return;
        }
    }
}
