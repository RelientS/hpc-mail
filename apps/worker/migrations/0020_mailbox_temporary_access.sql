CREATE TABLE `mailbox_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` integer NOT NULL,
	`owner_id` integer NOT NULL,
	`owner_auth_version` integer NOT NULL,
	`password_hash` text NOT NULL,
	`max_logins` integer NOT NULL,
	`used_logins` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_access_grants_mailbox_id_unique` ON `mailbox_access_grants` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `mailbox_access_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `mailbox_access_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mailbox_access_sessions_grant` ON `mailbox_access_sessions` (`grant_id`);--> statement-breakpoint
CREATE INDEX `idx_mailbox_access_sessions_expiry` ON `mailbox_access_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TRIGGER mailbox_access_consume_login AFTER INSERT ON mailbox_access_sessions
BEGIN
  UPDATE mailbox_access_grants SET used_logins = used_logins + 1
  WHERE id = NEW.grant_id AND used_logins < max_logins;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'mailbox login quota exhausted') END;
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_access_revoke_transfer AFTER UPDATE OF user_id, address ON mailboxes
WHEN OLD.user_id != NEW.user_id OR OLD.address != NEW.address
BEGIN
  DELETE FROM mailbox_access_grants WHERE mailbox_id = NEW.id;
END;
