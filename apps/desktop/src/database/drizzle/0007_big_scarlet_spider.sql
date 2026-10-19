CREATE INDEX session_turns_session_created_idx ON session_turns (session_id,created_at,id);
--> statement-breakpoint
CREATE INDEX sessions_activity_idx ON sessions (coalesce("last_message_at","updated_at") DESC, "id" DESC);
