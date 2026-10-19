-- =============================================================================
-- Tieout migration 0011: a resumed run replays the result of the same tool call
--
-- A resumed run replays recorded tool results instead of calling the tools again. They were
-- matched by position (the n-th action), which is only safe for the deterministic offline
-- engine: a resumed live (Claude) run counts its actions from zero again, so the model could be
-- handed another call's output. Each call now records a key that identifies it — the model's
-- tool_use id in live mode; position, tool and an input hash for the offline engine — and replay
-- matches on that key. Calls recorded before this migration keep a key nothing matches, so they
-- run again (reads only) rather than replay a wrong result.
-- =============================================================================

ALTER TABLE agent_tool_calls ADD COLUMN call_key TEXT;
UPDATE agent_tool_calls SET call_key = 'legacy:' || seq::text WHERE call_key IS NULL;
ALTER TABLE agent_tool_calls ALTER COLUMN call_key SET NOT NULL;
CREATE UNIQUE INDEX agent_tool_calls_call_key ON agent_tool_calls (run_id, call_key);
