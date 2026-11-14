CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`business_id` text,
	`detail_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_business_idx` ON `admin_audit_log` (`business_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_firebase_uid` text NOT NULL,
	`owner_email` text NOT NULL,
	`name` text NOT NULL,
	`doc_type` text,
	`doc_number` text,
	`whatsapp_phone` text,
	`whatsapp_verified_at` integer,
	`payment_methods_info` text,
	`subscription_plan` text DEFAULT 'TRIAL_3D' NOT NULL,
	`subscription_expires_at` integer NOT NULL,
	`grace_unlock_ends_at` integer,
	`free_forever_at` integer,
	`suspended_at` integer,
	`quota_cycle_started_at` integer NOT NULL,
	`ai_ocr_used_count` integer DEFAULT 0 NOT NULL,
	`ai_chat_used_count` integer DEFAULT 0 NOT NULL,
	`wa_reminders_used_count` integer DEFAULT 0 NOT NULL,
	`default_alert_days` integer DEFAULT 30 NOT NULL,
	`sarin_settings_json` text,
	`terms_accepted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "businesses_plan_ck" CHECK(subscription_plan IN ('TRIAL_3D', 'PASS_7D', 'PASS_15D', 'PASS_30D')),
	CONSTRAINT "businesses_contadores_ck" CHECK("businesses"."ai_ocr_used_count" >= 0 AND "businesses"."ai_chat_used_count" >= 0 AND "businesses"."wa_reminders_used_count" >= 0),
	CONSTRAINT "businesses_alert_days_ck" CHECK("businesses"."default_alert_days" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `businesses_owner_uid_uq` ON `businesses` (`owner_firebase_uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `businesses_whatsapp_phone_uq` ON `businesses` (`whatsapp_phone`);--> statement-breakpoint
CREATE TABLE `debtors` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`unique_code` text NOT NULL,
	`full_name` text NOT NULL,
	`alias_reference` text,
	`doc_type` text,
	`doc_number` text,
	`doc_last4` text,
	`whatsapp_phone` text,
	`wa_consent_at` integer,
	`wa_opt_out_at` integer,
	`credit_limit_cop` integer,
	`current_balance_cop` integer DEFAULT 0 NOT NULL,
	`oldest_unpaid_date` integer,
	`promised_payment_date` integer,
	`blacklisted_at` integer,
	`archived_at` integer,
	`last_reminder_sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "debtors_saldo_ck" CHECK(typeof(current_balance_cop) = 'integer' AND "debtors"."current_balance_cop" >= 0),
	CONSTRAINT "debtors_doc_ck" CHECK(("debtors"."doc_number" IS NULL) = ("debtors"."doc_type" IS NULL)),
	CONSTRAINT "debtors_tope_ck" CHECK("debtors"."credit_limit_cop" IS NULL OR "debtors"."credit_limit_cop" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `debtors_code_uq` ON `debtors` (`business_id`,`unique_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `debtors_negocio_id_uq` ON `debtors` (`business_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `debtors_doc_uq` ON `debtors` (`business_id`,`doc_type`,`doc_number`) WHERE doc_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX `debtors_name_idx` ON `debtors` (`business_id`,`full_name`);--> statement-breakpoint
CREATE TABLE `ledger_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`debtor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_cop` integer NOT NULL,
	`status` text NOT NULL,
	`balance_after_cop` integer,
	`description` text NOT NULL,
	`evidence_r2_key` text,
	`due_date` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`source` text NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_id`,`debtor_id`) REFERENCES `debtors`(`business_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_amount_ck" CHECK(typeof(amount_cop) = 'integer' AND "ledger_transactions"."amount_cop" > 0),
	CONSTRAINT "ledger_confirmado_ck" CHECK("ledger_transactions"."status" <> 'CONFIRMADO' OR ("ledger_transactions"."balance_after_cop" IS NOT NULL AND "ledger_transactions"."confirmed_at" IS NOT NULL)),
	CONSTRAINT "ledger_type_ck" CHECK(type IN ('FIADO', 'ABONO', 'AJUSTE_SUMA', 'AJUSTE_RESTA')),
	CONSTRAINT "ledger_status_ck" CHECK(status IN ('CONFIRMADO', 'PENDIENTE_VERIFICACION_WHATSAPP', 'RECHAZADO')),
	CONSTRAINT "ledger_source_ck" CHECK(source IN ('MOSTRADOR', 'SARIN_TEXT', 'SARIN_AUDIO', 'SARIN_IMAGE_OCR', 'WHATSAPP_BOT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_request_uq` ON `ledger_transactions` (`business_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `ledger_debtor_idx` ON `ledger_transactions` (`business_id`,`debtor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `subscription_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`plan_requested` text NOT NULL,
	`days_to_add` integer NOT NULL,
	`amount_cop` integer NOT NULL,
	`receipt_r2_key` text NOT NULL,
	`ocr_extracted_amount` integer,
	`ocr_reference_number` text,
	`grace_started_at` integer,
	`status` text DEFAULT 'PENDING_REVIEW' NOT NULL,
	`reviewed_by_email` text,
	`review_note` text,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_plan_ck" CHECK(plan_requested IN ('TRIAL_3D', 'PASS_7D', 'PASS_15D', 'PASS_30D')),
	CONSTRAINT "payments_status_ck" CHECK(status IN ('PENDING_REVIEW', 'PAID', 'REJECTED')),
	CONSTRAINT "payments_montos_ck" CHECK(typeof(amount_cop) = 'integer' AND typeof(days_to_add) = 'integer' AND "subscription_payments"."amount_cop" > 0 AND "subscription_payments"."days_to_add" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_un_pendiente_uq` ON `subscription_payments` (`business_id`) WHERE status = 'PENDING_REVIEW';--> statement-breakpoint
CREATE INDEX `payments_business_idx` ON `subscription_payments` (`business_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_ocr_ref_idx` ON `subscription_payments` (`ocr_reference_number`);