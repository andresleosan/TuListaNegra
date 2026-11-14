-- Escrito a mano (drizzle-kit no genera disparadores): el libro y la auditoría no se editan ni se borran (B3).
-- Única excepción: de un movimiento pendiente pueden cambiar el monto y el estado (confirmar o rechazar).
CREATE TRIGGER `ledger_no_delete` BEFORE DELETE ON `ledger_transactions`
BEGIN SELECT RAISE(ABORT, 'ledger: las filas no se borran'); END;
--> statement-breakpoint
-- REPLACE / INSERT OR REPLACE borran sin disparar el trigger de DELETE: se corta antes, al insertar un repetido.
CREATE TRIGGER `ledger_no_replace` BEFORE INSERT ON `ledger_transactions`
WHEN EXISTS (SELECT 1 FROM `ledger_transactions` WHERE id = NEW.id OR (business_id = NEW.business_id AND request_id = NEW.request_id))
BEGIN SELECT RAISE(ABORT, 'ledger: movimiento repetido'); END;
--> statement-breakpoint
CREATE TRIGGER `ledger_no_update` BEFORE UPDATE ON `ledger_transactions`
WHEN OLD.status <> 'PENDIENTE_VERIFICACION_WHATSAPP'
BEGIN SELECT RAISE(ABORT, 'ledger: solo un pendiente puede cambiar'); END;
--> statement-breakpoint
CREATE TRIGGER `ledger_pendiente_acotado` BEFORE UPDATE ON `ledger_transactions`
WHEN OLD.status = 'PENDIENTE_VERIFICACION_WHATSAPP' AND (
  NEW.id IS NOT OLD.id OR NEW.business_id IS NOT OLD.business_id OR NEW.debtor_id IS NOT OLD.debtor_id
  OR NEW.request_id IS NOT OLD.request_id OR NEW.type IS NOT OLD.type OR NEW.description IS NOT OLD.description
  OR NEW.evidence_r2_key IS NOT OLD.evidence_r2_key OR NEW.due_date IS NOT OLD.due_date
  OR NEW.created_at IS NOT OLD.created_at OR NEW.source IS NOT OLD.source
)
BEGIN SELECT RAISE(ABORT, 'ledger: de un pendiente solo cambian monto y estado'); END;
--> statement-breakpoint
CREATE TRIGGER `audit_no_delete` BEFORE DELETE ON `admin_audit_log`
BEGIN SELECT RAISE(ABORT, 'audit: solo se añade'); END;
--> statement-breakpoint
CREATE TRIGGER `audit_no_update` BEFORE UPDATE ON `admin_audit_log`
BEGIN SELECT RAISE(ABORT, 'audit: solo se añade'); END;
--> statement-breakpoint
CREATE TRIGGER `audit_no_replace` BEFORE INSERT ON `admin_audit_log`
WHEN EXISTS (SELECT 1 FROM `admin_audit_log` WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'audit: solo se añade'); END;
