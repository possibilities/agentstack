// Generated from domain types by scripts/generate-output-schemas.mjs.
import { z } from "zod";

export const StatsDataSchema = z.looseObject({
  "db_path": z.string(),
  "db_size_bytes": z.number(),
  "document_count": z.number(),
  "chunk_count": z.number(),
  "total_chars": z.number(),
  "by_source_type": z.array(z.looseObject({
  "source_type": z.string(),
  "count": z.number()
})),
  "top_tags": z.array(z.looseObject({
  "tag": z.string(),
  "count": z.number()
})),
  "recent": z.array(z.looseObject({
  "document_id": z.number(),
  "title": z.union([z.null(), z.string()]),
  "source_uri": z.string(),
  "source_type": z.string(),
  "updated_at": z.string()
})),
  "relation_count": z.number(),
  "failed_relation_count": z.number()
});

export const SearchDataSchema = z.looseObject({
  "query": z.string(),
  "normalized_query": z.string(),
  "mode": z.union([z.literal("any"), z.literal("all"), z.literal("raw")]),
  "limit": z.number(),
  "offset": z.number(),
  "filters": z.looseObject({
  "tag": z.string().optional(),
  "source_type": z.string().optional(),
  "content_kind": z.union([z.literal("post"), z.literal("thread"), z.literal("article")]).optional(),
  "collection": z.string().optional(),
  "source": z.string().optional(),
  "resource_kind": z.string().optional(),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]).optional(),
  "date": z.string().optional(),
  "date_from": z.string().optional(),
  "date_to": z.string().optional(),
  "local_path": z.string().optional()
}),
  "results": z.array(z.looseObject({
  "document_id": z.number(),
  "resource_id": z.union([z.null(), z.number()]),
  "resource_kind": z.string(),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]),
  "collections": z.array(z.string()),
  "sources": z.array(z.looseObject({
  "source_type": z.string(),
  "identifier": z.string()
})),
  "relations": z.array(z.looseObject({
  "relation_id": z.number(),
  "direction": z.union([z.literal("outbound"), z.literal("inbound")]),
  "relation_type": z.string(),
  "status": z.string(),
  "linked_document_id": z.number(),
  "linked_resource_id": z.union([z.null(), z.number()]),
  "linked_title": z.union([z.null(), z.string()]),
  "linked_resource_kind": z.string(),
  "linked_sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")])
})),
  "chunk_id": z.number(),
  "chunk_index": z.number(),
  "title": z.union([z.null(), z.string()]),
  "source_uri": z.string(),
  "source_type": z.string(),
  "content_kind": z.union([z.null(), z.literal("post"), z.literal("thread"), z.literal("article")]),
  "content_item_count": z.union([z.null(), z.number()]),
  "tags": z.array(z.string()),
  "updated_at": z.string(),
  "start_char": z.number(),
  "end_char": z.number(),
  "score": z.number(),
  "snippet": z.string()
})),
  "next_offset": z.union([z.null(), z.number()])
});

export const ContextDataSchema = z.looseObject({
  "query": z.string(),
  "filters": z.looseObject({
  "tag": z.string().optional(),
  "source_type": z.string().optional(),
  "content_kind": z.union([z.literal("post"), z.literal("thread"), z.literal("article")]).optional(),
  "collection": z.string().optional(),
  "source": z.string().optional(),
  "resource_kind": z.string().optional(),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]).optional(),
  "date": z.string().optional(),
  "date_from": z.string().optional(),
  "date_to": z.string().optional(),
  "local_path": z.string().optional()
}),
  "limit": z.number(),
  "max_chars": z.number(),
  "returned_chars": z.number(),
  "truncated": z.boolean(),
  "hits": z.array(z.looseObject({
  "document_id": z.number(),
  "resource_id": z.union([z.null(), z.number()]),
  "resource_kind": z.string(),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]),
  "collections": z.array(z.string()),
  "sources": z.array(z.looseObject({
  "source_type": z.string(),
  "identifier": z.string()
})),
  "relations": z.array(z.looseObject({
  "relation_id": z.number(),
  "direction": z.union([z.literal("outbound"), z.literal("inbound")]),
  "relation_type": z.string(),
  "status": z.string(),
  "linked_document_id": z.number(),
  "linked_resource_id": z.union([z.null(), z.number()]),
  "linked_title": z.union([z.null(), z.string()]),
  "linked_resource_kind": z.string(),
  "linked_sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")])
})),
  "chunk_id": z.number(),
  "chunk_index": z.number(),
  "title": z.union([z.null(), z.string()]),
  "source_uri": z.string(),
  "source_type": z.string(),
  "content_kind": z.union([z.null(), z.literal("post"), z.literal("thread"), z.literal("article")]),
  "content_item_count": z.union([z.null(), z.number()]),
  "tags": z.array(z.string()),
  "start_char": z.number(),
  "end_char": z.number(),
  "score": z.number(),
  "citation": z.string(),
  "content": z.string(),
  "truncated": z.boolean()
}))
});

export const DocumentDataSchema = z.looseObject({
  "document_id": z.number(),
  "title": z.union([z.null(), z.string()]),
  "source_uri": z.string(),
  "source_type": z.string(),
  "content_kind": z.union([z.null(), z.literal("post"), z.literal("thread"), z.literal("article")]),
  "content_item_count": z.union([z.null(), z.number()]),
  "tags": z.array(z.string()),
  "notes": z.union([z.null(), z.string()]),
  "size_chars": z.number(),
  "content_hash": z.string(),
  "created_at": z.string(),
  "updated_at": z.string(),
  "content": z.string(),
  "outbound_links": z.array(z.looseObject({
  "id": z.number(),
  "from_document_id": z.number(),
  "to_document_id": z.union([z.null(), z.number()]),
  "relation_type": z.string(),
  "discovered_url": z.union([z.null(), z.string()]),
  "resolved_url": z.union([z.null(), z.string()]),
  "status": z.string(),
  "error": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
})),
  "inbound_links": z.array(z.looseObject({
  "id": z.number(),
  "from_document_id": z.number(),
  "to_document_id": z.union([z.null(), z.number()]),
  "relation_type": z.string(),
  "discovered_url": z.union([z.null(), z.string()]),
  "resolved_url": z.union([z.null(), z.string()]),
  "status": z.string(),
  "error": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
})),
  "truncation": z.looseObject({
  "requested_char_limit": z.union([z.null(), z.number()]),
  "returned_chars": z.number(),
  "omitted_chars": z.number()
})
});

export const ChunkDataSchema = z.looseObject({
  "chunk_id": z.number(),
  "document_id": z.number(),
  "chunk_index": z.number(),
  "start_char": z.number(),
  "end_char": z.number(),
  "title": z.union([z.null(), z.string()]),
  "source_uri": z.string(),
  "source_type": z.string(),
  "content_kind": z.union([z.null(), z.literal("post"), z.literal("thread"), z.literal("article")]),
  "content_item_count": z.union([z.null(), z.number()]),
  "tags": z.array(z.string()),
  "content": z.string()
});

export const TagsDataSchema = z.looseObject({
  "tags": z.array(z.looseObject({
  "tag": z.string(),
  "count": z.number()
}))
});

export const RecoveryImportReportSchema = z.looseObject({
  "schema_version": z.literal(1),
  "status": z.union([z.literal("verified"), z.literal("queued")]),
  "dry_run": z.boolean(),
  "generation_id": z.string(),
  "counts": z.looseObject({
  "candidate_rows": z.number(),
  "baseline_candidate_rows": z.number(),
  "appended_candidate_rows": z.number(),
  "telegram_candidate_rows": z.number(),
  "telegram_observations": z.number(),
  "telegram_provenance_merges": z.number(),
  "catalog_memberships": z.number(),
  "approved_offline_artifacts": z.number(),
  "approved_online_jobs": z.number(),
  "blocked_review_jobs": z.number(),
  "excluded_candidates": z.number(),
  "evidence_only_candidates": z.number()
}),
  "dispositions": z.looseObject({
  "approved_online_backfill_telegram_human": z.number(),
  "exclude_infrastructure": z.number(),
  "exclude_probable_test": z.number(),
  "import_offline": z.number(),
  "review": z.number(),
  "review_discord": z.number(),
  "review_fetch": z.number(),
  "review_retry": z.number(),
  "review_telegram_bot_generated": z.number()
}),
  "jobs": z.looseObject({
  "queued": z.number(),
  "blocked": z.number(),
  "excluded": z.number(),
  "evidence_only": z.number(),
  "created": z.number(),
  "existing": z.number()
}),
  "effects": z.looseObject({
  "candidate_outcomes_created": z.number(),
  "candidate_outcomes_existing": z.number(),
  "observations_created": z.number(),
  "observations_existing": z.number(),
  "artifacts_created": z.number(),
  "artifacts_existing": z.number()
}),
  "run": z.looseObject({
  "id": z.union([z.null(), z.number()]),
  "state": z.union([z.literal("verified"), z.literal("pending")]),
  "operator_controlled": z.boolean(),
  "authorization_digest": z.union([z.null(), z.string()]),
  "allowed_job_kinds": z.array(z.string()),
  "expected_job_count": z.union([z.null(), z.number()])
})
});

export const AdmissionResultSchema = z.looseObject({
  "version": z.literal(1),
  "status": z.union([z.literal("queued"), z.literal("duplicate")]),
  "job_id": z.number(),
  "idempotency_key": z.string(),
  "intent_hash": z.string(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "wait_status": z.union([z.literal("terminal"), z.literal("timeout")]).optional()
});

export const AlreadyIndexedResultSchema = z.looseObject({
  "version": z.literal(1),
  "status": z.literal("already_indexed"),
  "document_id": z.number(),
  "resource_key": z.string()
});

export const SafeJobSchema = z.looseObject({
  "id": z.number(),
  "kind": z.string(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "sensitivity": z.string(),
  "resource_id": z.union([z.null(), z.number()]),
  "source_id": z.union([z.null(), z.number()]),
  "run_id": z.union([z.null(), z.number()]),
  "attempt_count": z.number(),
  "item_retry_count": z.number(),
  "run_at": z.string(),
  "failure_class": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const SafeJobRecordSchema = z.looseObject({
  "failure_summary": z.union([z.null(), z.string()]),
  "attempts": z.array(z.looseObject({
  "id": z.number(),
  "job_id": z.number(),
  "attempt_number": z.number(),
  "state": z.union([z.literal("failed"), z.literal("cancelled"), z.literal("leased"), z.literal("succeeded"), z.literal("stale")]),
  "lease_expires_at": z.string(),
  "heartbeat_at": z.string(),
  "started_at": z.string(),
  "finished_at": z.union([z.null(), z.string()]),
  "failure_class": z.union([z.null(), z.string()]),
  "failure_summary": z.union([z.null(), z.string()])
})),
  "transitions": z.array(z.looseObject({
  "id": z.number(),
  "job_id": z.number(),
  "attempt_id": z.union([z.null(), z.number()]),
  "from_state": z.union([z.null(), z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "to_state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "created_at": z.string()
})),
  "id": z.number(),
  "kind": z.string(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "sensitivity": z.string(),
  "resource_id": z.union([z.null(), z.number()]),
  "source_id": z.union([z.null(), z.number()]),
  "run_id": z.union([z.null(), z.number()]),
  "attempt_count": z.number(),
  "item_retry_count": z.number(),
  "run_at": z.string(),
  "failure_class": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const RevealedJobSchema = z.looseObject({
  "intent": z.unknown(),
  "artifacts": z.array(z.looseObject({
  "content_digest": z.string(),
  "media_type": z.string(),
  "byte_size": z.number(),
  "body": z.string()
})),
  "failure_summary": z.union([z.null(), z.string()]),
  "attempts": z.array(z.looseObject({
  "id": z.number(),
  "job_id": z.number(),
  "attempt_number": z.number(),
  "state": z.union([z.literal("failed"), z.literal("cancelled"), z.literal("leased"), z.literal("succeeded"), z.literal("stale")]),
  "lease_expires_at": z.string(),
  "heartbeat_at": z.string(),
  "started_at": z.string(),
  "finished_at": z.union([z.null(), z.string()]),
  "failure_class": z.union([z.null(), z.string()]),
  "failure_summary": z.union([z.null(), z.string()])
})),
  "transitions": z.array(z.looseObject({
  "id": z.number(),
  "job_id": z.number(),
  "attempt_id": z.union([z.null(), z.number()]),
  "from_state": z.union([z.null(), z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "to_state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "created_at": z.string()
})),
  "id": z.number(),
  "kind": z.string(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "sensitivity": z.string(),
  "resource_id": z.union([z.null(), z.number()]),
  "source_id": z.union([z.null(), z.number()]),
  "run_id": z.union([z.null(), z.number()]),
  "attempt_count": z.number(),
  "item_retry_count": z.number(),
  "run_at": z.string(),
  "failure_class": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const JobStatsSchema = z.looseObject({
  "total": z.number(),
  "by_state": z.looseObject({
  "queued": z.number(),
  "running": z.number(),
  "retry_wait": z.number(),
  "blocked": z.number(),
  "failed": z.number(),
  "completed": z.number(),
  "excluded": z.number(),
  "cancelled": z.number()
}),
  "runnable_due": z.number(),
  "active_leases": z.number(),
  "stale_leases": z.number(),
  "oldest_runnable_at": z.union([z.null(), z.string()])
});

export const SafeRunRecordSchema = z.looseObject({
  "id": z.number(),
  "run_type": z.string(),
  "source_id": z.union([z.null(), z.number()]),
  "state": z.union([z.literal("pending"), z.literal("failed"), z.literal("completed"), z.literal("cancelled"), z.literal("active"), z.literal("completed_with_review")]),
  "operator_controlled": z.boolean(),
  "execution_mode": z.union([z.null(), z.literal("offline"), z.literal("online")]),
  "authorization_digest": z.union([z.null(), z.string()]),
  "allowed_job_kinds": z.array(z.string()),
  "expected_job_count": z.union([z.null(), z.number()]),
  "counts": z.looseObject({
  "jobs": z.number(),
  "attempts": z.number(),
  "by_job_state": z.looseObject({
  "queued": z.number(),
  "running": z.number(),
  "retry_wait": z.number(),
  "blocked": z.number(),
  "failed": z.number(),
  "completed": z.number(),
  "excluded": z.number(),
  "cancelled": z.number()
}),
  "by_attempt_state": z.looseObject({
  "failed": z.number(),
  "cancelled": z.number(),
  "leased": z.number(),
  "succeeded": z.number(),
  "stale": z.number()
}),
  "by_kind": z.record(z.string(), z.number()),
  "by_failure_class": z.looseObject({
  "infra": z.number(),
  "item_transient": z.number(),
  "permanent": z.number(),
  "auth_config": z.number()
})
}),
  "quiescence": z.looseObject({
  "runnable_due": z.number(),
  "active_leases": z.number(),
  "stale_leases": z.number(),
  "execution_active": z.boolean(),
  "quiescent": z.boolean()
}),
  "jobs": z.array(z.looseObject({
  "id": z.number(),
  "kind": z.string(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "sensitivity": z.string(),
  "resource_id": z.union([z.null(), z.number()]),
  "source_id": z.union([z.null(), z.number()]),
  "run_id": z.union([z.null(), z.number()]),
  "attempt_count": z.number(),
  "item_retry_count": z.number(),
  "run_at": z.string(),
  "failure_class": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
})),
  "jobs_truncated": z.boolean(),
  "started_at": z.union([z.null(), z.string()]),
  "finished_at": z.union([z.null(), z.string()]),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const DoctorReportSchema = z.looseObject({
  "healthy": z.boolean(),
  "checks": z.array(z.looseObject({
  "name": z.string(),
  "status": z.union([z.literal("failed"), z.literal("ok"), z.literal("warning")]),
  "detail": z.string()
}))
});

export const SourceListItemSchema = z.looseObject({
  "id": z.string(),
  "database_id": z.number(),
  "version": z.number(),
  "kind": z.string(),
  "display_name": z.string(),
  "enabled": z.boolean(),
  "paused": z.boolean(),
  "executable": z.boolean(),
  "schedule": z.union([z.null(), z.looseObject({
  "cadence_seconds": z.number()
})]),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]),
  "collections": z.array(z.string()),
  "limits": z.union([z.null(), z.looseObject({
  "max_items_per_run": z.number(),
  "max_pages_per_run": z.number()
})]),
  "credential_reference_count": z.number(),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const SourceDetailSchema = z.looseObject({
  "payload": z.record(z.string(), z.unknown()),
  "pause_reason": z.union([z.null(), z.string()]),
  "health": z.looseObject({
  "state": z.union([z.literal("warning"), z.literal("never"), z.literal("healthy"), z.literal("unhealthy")]),
  "detail": z.union([z.null(), z.string()]),
  "last_evaluated_at": z.union([z.null(), z.string()]),
  "last_success_at": z.union([z.null(), z.string()]),
  "next_due_at": z.union([z.null(), z.string()])
}),
  "checkpoint": z.looseObject({
  "present": z.boolean(),
  "run_id": z.union([z.null(), z.number()]),
  "committed_at": z.union([z.null(), z.string()])
}),
  "id": z.string(),
  "database_id": z.number(),
  "version": z.number(),
  "kind": z.string(),
  "display_name": z.string(),
  "enabled": z.boolean(),
  "paused": z.boolean(),
  "executable": z.boolean(),
  "schedule": z.union([z.null(), z.looseObject({
  "cadence_seconds": z.number()
})]),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]),
  "collections": z.array(z.string()),
  "limits": z.union([z.null(), z.looseObject({
  "max_items_per_run": z.number(),
  "max_pages_per_run": z.number()
})]),
  "credential_reference_count": z.number(),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const SourceStatusSchema = z.looseObject({
  "due": z.boolean(),
  "latest_run": z.union([z.null(), z.looseObject({
  "id": z.number(),
  "state": z.union([z.literal("pending"), z.literal("failed"), z.literal("completed"), z.literal("cancelled"), z.literal("active"), z.literal("completed_with_review")]),
  "outcome": z.union([z.null(), z.literal("failed"), z.literal("cancelled"), z.literal("success"), z.literal("partial")]),
  "warnings": z.number(),
  "counts": z.looseObject({
  "discovered": z.number(),
  "admitted": z.number(),
  "suppressed": z.number()
}),
  "created_at": z.string(),
  "finished_at": z.union([z.null(), z.string()])
})]),
  "payload": z.record(z.string(), z.unknown()),
  "pause_reason": z.union([z.null(), z.string()]),
  "health": z.looseObject({
  "state": z.union([z.literal("warning"), z.literal("never"), z.literal("healthy"), z.literal("unhealthy")]),
  "detail": z.union([z.null(), z.string()]),
  "last_evaluated_at": z.union([z.null(), z.string()]),
  "last_success_at": z.union([z.null(), z.string()]),
  "next_due_at": z.union([z.null(), z.string()])
}),
  "checkpoint": z.looseObject({
  "present": z.boolean(),
  "run_id": z.union([z.null(), z.number()]),
  "committed_at": z.union([z.null(), z.string()])
}),
  "id": z.string(),
  "database_id": z.number(),
  "version": z.number(),
  "kind": z.string(),
  "display_name": z.string(),
  "enabled": z.boolean(),
  "paused": z.boolean(),
  "executable": z.boolean(),
  "schedule": z.union([z.null(), z.looseObject({
  "cadence_seconds": z.number()
})]),
  "sensitivity": z.union([z.literal("public"), z.literal("normal"), z.literal("sensitive"), z.literal("private")]),
  "collections": z.array(z.string()),
  "limits": z.union([z.null(), z.looseObject({
  "max_items_per_run": z.number(),
  "max_pages_per_run": z.number()
})]),
  "credential_reference_count": z.number(),
  "created_at": z.string(),
  "updated_at": z.string()
});

export const SourceSyncAdmissionSchema = z.looseObject({
  "source_id": z.string(),
  "source_database_id": z.number(),
  "status": z.union([z.literal("queued"), z.literal("duplicate"), z.literal("would_queue"), z.literal("not_due"), z.literal("disabled"), z.literal("paused"), z.literal("unsupported")]),
  "run_id": z.union([z.null(), z.number()]),
  "job_id": z.union([z.null(), z.number()]),
  "scheduled_for": z.union([z.null(), z.string()]),
  "dry_run": z.boolean()
});

export const SourceSyncWaitResultSchema = z.looseObject({
  "admission": z.looseObject({
  "source_id": z.string(),
  "source_database_id": z.number(),
  "status": z.union([z.literal("queued"), z.literal("duplicate"), z.literal("would_queue"), z.literal("not_due"), z.literal("disabled"), z.literal("paused"), z.literal("unsupported")]),
  "run_id": z.union([z.null(), z.number()]),
  "job_id": z.union([z.null(), z.number()]),
  "scheduled_for": z.union([z.null(), z.string()]),
  "dry_run": z.boolean()
}),
  "execution": z.union([z.null(), z.looseObject({
  "source_id": z.string(),
  "run_id": z.number(),
  "run_state": z.union([z.literal("pending"), z.literal("failed"), z.literal("completed"), z.literal("cancelled"), z.literal("active"), z.literal("completed_with_review")]),
  "outcome": z.union([z.null(), z.literal("failed"), z.literal("cancelled"), z.literal("success"), z.literal("partial")]),
  "terminal": z.boolean(),
  "warnings": z.number(),
  "counts": z.looseObject({
  "discovered": z.number(),
  "admitted": z.number(),
  "suppressed": z.number()
}),
  "checkpoint_committed": z.boolean(),
  "created_at": z.string(),
  "started_at": z.union([z.null(), z.string()]),
  "finished_at": z.union([z.null(), z.string()]),
  "job": z.union([z.null(), z.looseObject({
  "id": z.number(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "failure_class": z.union([z.null(), z.string()]),
  "failure_summary": z.union([z.null(), z.string()])
})])
})]),
  "timed_out": z.boolean()
});

export const SourceApplyResultSchema = z.looseObject({
  "source_id": z.string(),
  "database_id": z.number(),
  "version": z.number(),
  "created": z.boolean(),
  "changed": z.boolean()
});

export const BackupCreateResultSchema = z.looseObject({
  "backup_path": z.string(),
  "manifest_path": z.string(),
  "database_path": z.string(),
  "created_at": z.string(),
  "schema_version": z.number(),
  "database_sha256": z.string(),
  "artifact_count": z.number()
});

export const BackupVerifyResultSchema = z.looseObject({
  "verified": z.boolean(),
  "backup_path": z.string(),
  "created_at": z.string(),
  "schema_version": z.number(),
  "supported_schema_version": z.number(),
  "schema_version_relationship": z.union([z.literal("current"), z.literal("older-migratable"), z.literal("newer-unsupported")]),
  "database_sha256": z.string(),
  "artifact_inventory_sha256": z.string(),
  "artifact_count": z.number(),
  "artifacts_checked": z.number(),
  "checks": z.array(z.looseObject({
  "name": z.union([z.literal("database_digest"), z.literal("database_integrity"), z.literal("schema_version"), z.literal("artifact_references"), z.literal("artifact_bytes"), z.literal("fts_rebuild")]),
  "status": z.union([z.literal("failed"), z.literal("ok")]),
  "detail": z.string()
}))
});

export const RecoveryOnlineReportSchema = z.looseObject({
  "schema_version": z.literal(1),
  "status": z.union([z.literal("completed"), z.literal("active"), z.literal("completed_with_review"), z.literal("paused"), z.literal("ready")]),
  "generation_id": z.string(),
  "generation_digest": z.string(),
  "manifest_digest": z.string(),
  "approval_digest": z.string(),
  "candidate_evidence_row_ids": z.array(z.string()),
  "snapshot": z.looseObject({
  "restore_verified": z.literal(true),
  "database_digest": z.string(),
  "artifact_inventory_digest": z.string(),
  "artifacts_checked": z.number(),
  "corpus_jobs": z.number(),
  "corpus_documents": z.number()
}),
  "offline_run": z.looseObject({
  "id": z.number(),
  "state": z.literal("completed"),
  "completed_artifact_jobs": z.number(),
  "succeeded_attempts": z.number()
}),
  "online_run": z.looseObject({
  "id": z.number(),
  "linked_offline_run_id": z.number(),
  "state": z.union([z.literal("completed"), z.literal("active"), z.literal("completed_with_review"), z.literal("paused"), z.literal("ready")]),
  "authorization_digest": z.string(),
  "allowed_job_kinds": z.tuple([z.literal("recovery_online")]),
  "expected_job_count": z.literal(2),
  "protected_jobs_unchanged": z.number(),
  "counts": z.looseObject({
  "jobs": z.number(),
  "attempts": z.number(),
  "completed": z.number(),
  "review": z.number(),
  "pending": z.number()
}),
  "created_at": z.string(),
  "updated_at": z.string(),
  "finished_at": z.union([z.null(), z.string()])
}),
  "items": z.array(z.looseObject({
  "candidate_evidence_row_id": z.string(),
  "job_id": z.number(),
  "state": z.union([z.literal("queued"), z.literal("running"), z.literal("retry_wait"), z.literal("blocked"), z.literal("failed"), z.literal("completed"), z.literal("excluded"), z.literal("cancelled")]),
  "outcome": z.string(),
  "attempt_ids": z.array(z.number()),
  "failure_class": z.union([z.null(), z.literal("infra"), z.literal("item_transient"), z.literal("permanent"), z.literal("auth_config")]),
  "artifact_digest": z.union([z.null(), z.string()]),
  "started_at": z.union([z.null(), z.string()]),
  "finished_at": z.union([z.null(), z.string()])
})),
  "artifact_digests": z.array(z.string()),
  "rollback": z.looseObject({
  "scope": z.literal("local_database_and_artifacts_only"),
  "snapshot_database_digest": z.string(),
  "remote_requests_reversible": z.literal(false),
  "steps": z.tuple([z.literal("quiesce_workers"), z.literal("verify_snapshot_digest"), z.literal("restore_snapshot_database_atomically"), z.literal("reconcile_unreferenced_artifacts_after_restore")])
})
});

export const WorkerResultSchema = z.looseObject({
  "worker_id": z.string(),
  "scope": z.union([z.null(), z.looseObject({
  "run_id": z.number(),
  "execution_mode": z.union([z.literal("offline"), z.literal("online")]),
  "authorization_digest": z.string(),
  "allowed_job_kinds": z.array(z.string()),
  "expected_job_count": z.number()
})]),
  "scheduled": z.number(),
  "recovered": z.number(),
  "claimed": z.number(),
  "completed": z.number(),
  "failed": z.number(),
  "fenced": z.number(),
  "stopped": z.boolean()
});

export const RetagResultSchema = z.looseObject({
  "success": z.literal(true),
  "dry_run": z.boolean(),
  "documents_scanned": z.number(),
  "documents_changed": z.number(),
  "documents_unchanged": z.number(),
  "changes": z.array(z.looseObject({
  "document_id": z.number(),
  "before": z.array(z.string()),
  "after": z.array(z.string())
}))
});
