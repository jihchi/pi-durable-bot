import { BOT } from "./telegram.ts";

// Synthetic identities only. These exercise the real polling ingress, not just the SDK's unused dispatcher.
export const ALLOWED_USER = { id: 111, is_bot: false, first_name: "Alice" };
export const OTHER_USER = { id: 222, is_bot: false, first_name: "Bob" };
export const ALLOWED_PHOTO = "allowlist-owner-photo";
export const OTHER_PHOTO = "allowlist-other-photo";

export function allowlistUpdates() {
  const cases: { name: string; allowed: boolean; update: { update_id: number; [key: string]: unknown } }[] = [];
  const group = { id: -100200, type: "supergroup", title: "Team" };
  const date = 1793080260;
  let messageId = 100;
  const add = (name: string, allowed: boolean, payload: Record<string, unknown>) => cases.push({ name, allowed, update: { update_id: 2000 + cases.length, ...payload } });
  for (const [name, from, allowed, photo] of [["owner", ALLOWED_USER, true, ALLOWED_PHOTO], ["other", OTHER_USER, false, OTHER_PHOTO]] as const) {
    const dm = { id: from.id, first_name: from.first_name, type: "private" };
    const message = (chat: { id: number; type: string; title?: string; first_name?: string } = group) => ({ message_id: messageId++, from, chat, date, text: "@pots_test_bot test", entities: [{ type: "mention", offset: 0, length: 14 }] });
    add(`${name} DM`, allowed, { message: message(dm) });
    add(`${name} group mention`, allowed, { message: message() });
    add(`${name} edit`, allowed, { edited_message: { ...message(), edit_date: date + 1 } });
    // The author of the embedded button message is deliberately not the person who clicks it.
    add(`${name} callback`, allowed, { callback_query: { id: `${name}-click`, from, chat_instance: "test", data: "deploy:test", message: { ...message(), from: allowed ? OTHER_USER : ALLOWED_USER } } });
    add(`${name} photo`, allowed, { message: { ...message(dm), photo: [{ file_id: photo, file_unique_id: photo, file_size: 4, width: 1, height: 1 }] } });
    add(`${name} reaction`, allowed, { message_reaction: { chat: group, message_id: 500, user: from, date, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } });
    add(`${name} command`, allowed, { message: { ...message(dm), text: "/status", entities: [{ type: "bot_command", offset: 0, length: 7 }] } });
    add(`${name} membership`, allowed, { my_chat_member: { chat: group, from, date, old_chat_member: { user: BOT, status: "left" }, new_chat_member: { user: BOT, status: "member" } } });
    add(`${name} service message`, allowed, { message: { ...message(), new_chat_title: "Team renamed" } });
    add(`${name} channel post with user`, allowed, { channel_post: message() });
    add(`${name} edited channel post with user`, allowed, { edited_channel_post: { ...message(), edit_date: date + 1 } });
  }
  const message = { message_id: messageId++, chat: group, date, text: "senderless" };
  add("senderless message", false, { message });
  add("senderless channel post", false, { channel_post: message });
  add("senderless edit", false, { edited_message: message });
  add("anonymous admin with allowed placeholder", false, { message: { ...message, from: ALLOWED_USER, sender_chat: group } });
  add("chat reaction with allowed placeholder", false, { message_reaction: { chat: group, message_id: 500, user: ALLOWED_USER, actor_chat: group, date, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } });
  add("missing callback actor", false, { callback_query: { id: "missing-user", chat_instance: "test", data: "test", message: { ...message, from: ALLOWED_USER } } });
  add("allowed chat is not an allowed sender", false, { message: { ...message, chat: { id: ALLOWED_USER.id, type: "private" }, from: OTHER_USER } });
  add("quoted owner does not authorize sender", false, { message: { ...message, from: OTHER_USER, reply_to_message: { ...message, from: ALLOWED_USER }, forward_origin: { type: "user", sender_user: ALLOWED_USER, date } } });
  add("owner may quote another user", true, { message: { ...message, message_id: messageId++, from: ALLOWED_USER, reply_to_message: { ...message, from: OTHER_USER } } });
  add("ambiguous update", false, { message: { ...message, from: OTHER_USER }, callback_query: { id: "mixed", from: ALLOWED_USER, chat_instance: "test", data: "test" } });
  add("unknown update", false, { poll: { id: "unsupported" } });
  return cases;
}
