ALTER TABLE `businesses` ADD `whatsapp_code_hash` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `whatsapp_code_expires_at` integer;--> statement-breakpoint
ALTER TABLE `businesses` ADD `whatsapp_code_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Escrito a mano (drizzle-kit no genera disparadores). WAP-02: un número nuevo no hereda la verificación del anterior.
-- Cambie por donde cambie `whatsapp_phone`, se borran la verificación y el código pendiente.
CREATE TRIGGER `businesses_telefono_nuevo` AFTER UPDATE OF `whatsapp_phone` ON `businesses`
WHEN OLD.whatsapp_phone IS NOT NEW.whatsapp_phone
BEGIN
  UPDATE `businesses` SET whatsapp_verified_at = NULL, whatsapp_code_hash = NULL, whatsapp_code_expires_at = NULL, whatsapp_code_attempts = 0
  WHERE id = NEW.id;
END;
