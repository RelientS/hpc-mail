import { z } from 'zod';

export const createMailboxAccessSchema = z.object({
  maxLogins: z.number().int().min(1).max(100),
}).strict();
export const mailboxLoginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
}).strict();
export const mailboxAccessListSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
}).strict();

export interface MailboxAccessStatus {
  enabled: boolean;
  maxLogins: number;
  usedLogins: number;
  remainingLogins: number;
}
export interface CreatedMailboxAccess extends MailboxAccessStatus {
  password: string;
}
export interface MailboxAccessSession {
  address: string;
  displayName: string;
  expiresAt: string;
  remainingLogins: number;
}
export interface MailboxAccessMessage {
  id: number;
  address: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  preview: string;
  verificationCode: string;
  createdAt: string;
}
export interface MailboxAccessMessagePage {
  items: MailboxAccessMessage[];
  nextBefore: number | null;
}
export interface MailboxAccessMessageDetail extends MailboxAccessMessage {
  bodyText: string;
  bodyHtml: string;
  hasRaw: boolean;
  attachments: { id: number; filename: string; size: number; url: string }[];
}
