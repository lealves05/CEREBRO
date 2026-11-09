-- Briefing diário pelo WhatsApp (por número vinculado)
ALTER TABLE whatsapp_links ADD COLUMN briefing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_links ADD COLUMN briefing_time TEXT NOT NULL DEFAULT '07:30';
ALTER TABLE whatsapp_links ADD COLUMN briefing_last TEXT;
