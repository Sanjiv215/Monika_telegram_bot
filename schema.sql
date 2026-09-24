-- ==============================================================================
-- WhatsApp AI Assistant Database Schema (Supabase PostgreSQL)
-- ==============================================================================

-- 1. Create table for conversation memory (Chat History)
CREATE TABLE IF NOT EXISTS public.chat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_phone TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'model', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Index for high-performance retrieval of conversation context by sender
CREATE INDEX IF NOT EXISTS idx_chat_history_sender_created 
ON public.chat_history (sender_phone, created_at DESC);

-- 2. Create table for Webhook Message Deduplication
-- WhatsApp sends retries on timeouts/failures; this table prevents duplicate processing
CREATE TABLE IF NOT EXISTS public.processed_messages (
    whatsapp_message_id TEXT PRIMARY KEY,
    sender_phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Index to support automatic TTL/pruning queries if needed
CREATE INDEX IF NOT EXISTS idx_processed_messages_created 
ON public.processed_messages (created_at DESC);

-- ==============================================================================
-- Row Level Security (RLS) Configuration
-- ==============================================================================

-- Enable RLS to enforce security
ALTER TABLE public.chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_messages ENABLE ROW LEVEL SECURITY;

-- Allow service_role key full read/write access (Used by Supabase Edge Functions)
DROP POLICY IF EXISTS "Service role full access on chat_history" ON public.chat_history;
CREATE POLICY "Service role full access on chat_history" 
ON public.chat_history
FOR ALL 
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on processed_messages" ON public.processed_messages;
CREATE POLICY "Service role full access on processed_messages" 
ON public.processed_messages
FOR ALL 
TO service_role
USING (true)
WITH CHECK (true);

-- Optional: Block all public anon key access by default
DROP POLICY IF EXISTS "Deny public access on chat_history" ON public.chat_history;
CREATE POLICY "Deny public access on chat_history" 
ON public.chat_history
FOR ALL 
TO anon
USING (false);

DROP POLICY IF EXISTS "Deny public access on processed_messages" ON public.processed_messages;
CREATE POLICY "Deny public access on processed_messages" 
ON public.processed_messages
FOR ALL 
TO anon
USING (false);

-- ==============================================================================
-- Optional Retention Cleanup (Run periodically or via pg_cron)
-- ==============================================================================
-- Deletes processed message deduplication records older than 7 days
CREATE OR REPLACE FUNCTION public.cleanup_old_processed_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM public.processed_messages 
    WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$;
