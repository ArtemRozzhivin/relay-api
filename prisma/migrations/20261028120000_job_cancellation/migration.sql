-- Cancellation is a request and an acknowledgement, so it is two things rather
-- than one: a flag the API sets while the job may still be running, and a
-- terminal status only the worker can move it to — because only the worker
-- knows the handler has reached a point where stopping leaves nothing half done.
--
-- A status, unlike a job type, is a closed set owned by the state machine, so
-- it stays an enum (D21 moved only `type` off one). The cost is the one D21 was
-- avoiding: Postgres has no DROP VALUE, so this label is permanent.
ALTER TYPE "JobStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "Job" ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false;
