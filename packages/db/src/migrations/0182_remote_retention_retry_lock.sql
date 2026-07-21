ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "remote_retention_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "remote_retention_claimed_by_run_id" uuid;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lock_heartbeat_retry_source_before_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_claimed_at timestamp with time zone;
BEGIN
  SELECT "remote_retention_claimed_at"
    INTO source_claimed_at
    FROM "heartbeat_runs"
    WHERE "id" = NEW."retry_of_run_id"
    FOR UPDATE;

  IF FOUND AND source_claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'retry source run is unavailable after remote retention claim'
      USING ERRCODE = '23514',
            CONSTRAINT = 'heartbeat_runs_retry_source_not_retention_claimed';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_lock_retry_source_before_write" ON "heartbeat_runs";
--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_lock_retry_source_before_write"
BEFORE INSERT OR UPDATE OF "retry_of_run_id", "status" ON "heartbeat_runs"
FOR EACH ROW
WHEN (
  NEW."retry_of_run_id" IS NOT NULL
  AND NEW."status" IN ('queued', 'scheduled_retry', 'running')
)
EXECUTE FUNCTION "lock_heartbeat_retry_source_before_write"();
