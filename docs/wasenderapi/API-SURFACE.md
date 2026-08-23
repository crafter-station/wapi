# WasenderAPI — API Surface

Base URL: `https://www.wasenderapi.com`  
Auth: `Authorization: Bearer <token>`

## channels-communities

| Method | Path | Operation | Params |
|---|---|---|---|
| `POST` | `/api/send-message` | Send Channel Message | to,text |

## contacts

| Method | Path | Operation | Params |
|---|---|---|---|
| `GET` | `/api/contacts` | Get All Contacts | — |
| `PUT` | `/api/contacts` | Create or Update Contact | jid |
| `GET` | `/api/contacts/{contactPhoneNumber}` | Get Contact Info | contactPhoneNumber |
| `POST` | `/api/contacts/{contactPhoneNumber}/block` | Block Contact | contactPhoneNumber |
| `GET` | `/api/contacts/{contactPhoneNumber}/picture` | Get Contact Profile Picture | contactPhoneNumber |
| `POST` | `/api/contacts/{contactPhoneNumber}/unblock` | Unblock Contact | contactPhoneNumber |
| `GET` | `/api/lid-from-pn/{pn}` | Get LID from Phone Number | pn |
| `GET` | `/api/pn-from-lid/{lid}` | Get Phone Number from LID | lid |

## groups

| Method | Path | Operation | Params |
|---|---|---|---|
| `GET` | `/api/groups` | Get All Groups | — |
| `POST` | `/api/groups` | Create a New Group | name |
| `POST` | `/api/groups/invite/accept` | Accept Group Invite | code |
| `GET` | `/api/groups/invite/{inviteCode}` | Get Group Invite Info | inviteCode |
| `POST` | `/api/groups/{groupId}/leave` | Leave Group | groupId |
| `PUT` | `/api/groups/{groupId}/participants/update` | Update Group Participants | groupId,action,participants |
| `GET` | `/api/groups/{groupJid}/invite-link` | Get Group Invite Link | groupJid |
| `GET` | `/api/groups/{groupJid}/metadata` | Get Group Metadata | groupJid |
| `GET` | `/api/groups/{groupJid}/participants` | Get Group Participants | groupJid |
| `POST` | `/api/groups/{groupJid}/participants/add` | Add Group Participants | groupJid,participants |
| `POST` | `/api/groups/{groupJid}/participants/remove` | Remove Group Participants | groupJid,participants |
| `GET` | `/api/groups/{groupJid}/picture` | Get Group Profile Picture | groupJid |
| `PUT` | `/api/groups/{groupJid}/settings` | Update Group Settings | groupJid |
| `POST` | `/api/send-message` | Send Group Message | to,text |
| `POST` | `/api/send-message` | Send Message with Mentions | to,text,mentions |

## messages

| Method | Path | Operation | Params |
|---|---|---|---|
| `POST` | `/api/decrypt-media` | Decrypt Media File | data |
| `POST` | `/api/messages/read` | Mark Message as Read | key,key.id,key.remoteJid,key.fromMe |
| `POST` | `/api/messages/{message}/resend` | Resend Failed Message | message |
| `DELETE` | `/api/messages/{msgId}` | Delete a Message | msgId |
| `PUT` | `/api/messages/{msgId}` | Edit a Message | msgId,text |
| `GET` | `/api/messages/{msgId}/info` | Get Message Info | msgId |
| `POST` | `/api/send-message` | Send Audio Message | to,audioUrl |
| `POST` | `/api/send-message` | Send Contact Card | to,contact |
| `POST` | `/api/send-message` | Send Document Message | to,documentUrl |
| `POST` | `/api/send-message` | Send Image Message | to,imageUrl |
| `POST` | `/api/send-message` | Send Location | to,location |
| `POST` | `/api/send-message` | Send Poll Message | to,poll,pool.question,pool.options |
| `POST` | `/api/send-message` | Send Quoted Message | to |
| `POST` | `/api/send-message` | Send Sticker Message | to,stickerUrl |
| `POST` | `/api/send-message` | Send Text Message | to,text |
| `POST` | `/api/send-message` | Send Video Message | to,videoUrl |
| `POST` | `/api/send-message` | Send View Once Message | to,viewOnce |
| `POST` | `/api/upload` | Upload Media File | — |

## sessions

| Method | Path | Operation | Params |
|---|---|---|---|
| `GET` | `/api/fetch-username/{contact_identifier}` | Fetch Username | contact_identifier |
| `GET` | `/api/on-whatsapp/{contact_identifier}` | Check if a contact is on WhatsApp | contact_identifier |
| `POST` | `/api/passkey/confirm` | Confirm Passkey Link | token,requestId |
| `GET` | `/api/passkey/pending` | Get Pending Passkey Request | token |
| `POST` | `/api/passkey/response` | Submit Passkey Response | token,requestId,credential |
| `POST` | `/api/send-presence-update` | Send Presence Update | jid,type |
| `GET` | `/api/status` | Get WhatsApp Session Status | — |
| `GET` | `/api/user` | Get Session User Info | — |
| `GET` | `/api/whatsapp-sessions` | Get All WhatsApp Sessions | — |
| `POST` | `/api/whatsapp-sessions` | Create WhatsApp Session | name,phone_number,account_protection,log_messages |
| `DELETE` | `/api/whatsapp-sessions/{whatsappSession}` | Delete WhatsApp Session | whatsappSession |
| `GET` | `/api/whatsapp-sessions/{whatsappSession}` | Get WhatsApp Session Details | whatsappSession |
| `PUT` | `/api/whatsapp-sessions/{whatsappSession}` | Update WhatsApp Session | whatsappSession |
| `POST` | `/api/whatsapp-sessions/{whatsappSession}/connect` | Connect WhatsApp Session | whatsappSession |
| `POST` | `/api/whatsapp-sessions/{whatsappSession}/disconnect` | Disconnect WhatsApp Session | whatsappSession |
| `GET` | `/api/whatsapp-sessions/{whatsappSession}/message-logs` | Get Message Logs | whatsappSession |
| `GET` | `/api/whatsapp-sessions/{whatsappSession}/passkey-token` | Get Passkey Token | whatsappSession |
| `GET` | `/api/whatsapp-sessions/{whatsappSession}/qrcode` | Get WhatsApp Session QR Code | whatsappSession |
| `POST` | `/api/whatsapp-sessions/{whatsappSession}/regenerate-key` | Regenerate API Key | whatsappSession |
| `POST` | `/api/whatsapp-sessions/{whatsappSession}/restart` | Restart WhatsApp Session | whatsappSession |
| `GET` | `/api/whatsapp-sessions/{whatsappSession}/session-logs` | Get Session Logs | whatsappSession |

## webhooks

| Method | Path | Operation | Params |
|---|---|---|---|
| `POST` | `/your-webhook-url` | Webhook Setup | X-Webhook-Signature,Content-Type |

## Unique routes

- `DELETE /api/messages/{msgId}` → Delete a Message
- `DELETE /api/whatsapp-sessions/{whatsappSession}` → Delete WhatsApp Session
- `GET /api/contacts` → Get All Contacts
- `GET /api/contacts/{contactPhoneNumber}` → Get Contact Info
- `GET /api/contacts/{contactPhoneNumber}/picture` → Get Contact Profile Picture
- `GET /api/fetch-username/{contact_identifier}` → Fetch Username
- `GET /api/groups` → Get All Groups
- `GET /api/groups/invite/{inviteCode}` → Get Group Invite Info
- `GET /api/groups/{groupJid}/invite-link` → Get Group Invite Link
- `GET /api/groups/{groupJid}/metadata` → Get Group Metadata
- `GET /api/groups/{groupJid}/participants` → Get Group Participants
- `GET /api/groups/{groupJid}/picture` → Get Group Profile Picture
- `GET /api/lid-from-pn/{pn}` → Get LID from Phone Number
- `GET /api/messages/{msgId}/info` → Get Message Info
- `GET /api/on-whatsapp/{contact_identifier}` → Check if a contact is on WhatsApp
- `GET /api/passkey/pending` → Get Pending Passkey Request
- `GET /api/pn-from-lid/{lid}` → Get Phone Number from LID
- `GET /api/status` → Get WhatsApp Session Status
- `GET /api/user` → Get Session User Info
- `GET /api/whatsapp-sessions` → Get All WhatsApp Sessions
- `GET /api/whatsapp-sessions/{whatsappSession}` → Get WhatsApp Session Details
- `GET /api/whatsapp-sessions/{whatsappSession}/message-logs` → Get Message Logs
- `GET /api/whatsapp-sessions/{whatsappSession}/passkey-token` → Get Passkey Token
- `GET /api/whatsapp-sessions/{whatsappSession}/qrcode` → Get WhatsApp Session QR Code
- `GET /api/whatsapp-sessions/{whatsappSession}/session-logs` → Get Session Logs
- `POST /api/contacts/{contactPhoneNumber}/block` → Block Contact
- `POST /api/contacts/{contactPhoneNumber}/unblock` → Unblock Contact
- `POST /api/decrypt-media` → Decrypt Media File
- `POST /api/groups` → Create a New Group
- `POST /api/groups/invite/accept` → Accept Group Invite
- `POST /api/groups/{groupId}/leave` → Leave Group
- `POST /api/groups/{groupJid}/participants/add` → Add Group Participants
- `POST /api/groups/{groupJid}/participants/remove` → Remove Group Participants
- `POST /api/messages/read` → Mark Message as Read
- `POST /api/messages/{message}/resend` → Resend Failed Message
- `POST /api/passkey/confirm` → Confirm Passkey Link
- `POST /api/passkey/response` → Submit Passkey Response
- `POST /api/send-message` → Send Channel Message, Send Group Message, Send Message with Mentions, Send Audio Message, Send Contact Card, Send Document Message, Send Image Message, Send Location, Send Poll Message, Send Quoted Message, Send Sticker Message, Send Text Message, Send Video Message, Send View Once Message
- `POST /api/send-presence-update` → Send Presence Update
- `POST /api/upload` → Upload Media File
- `POST /api/whatsapp-sessions` → Create WhatsApp Session
- `POST /api/whatsapp-sessions/{whatsappSession}/connect` → Connect WhatsApp Session
- `POST /api/whatsapp-sessions/{whatsappSession}/disconnect` → Disconnect WhatsApp Session
- `POST /api/whatsapp-sessions/{whatsappSession}/regenerate-key` → Regenerate API Key
- `POST /api/whatsapp-sessions/{whatsappSession}/restart` → Restart WhatsApp Session
- `POST /your-webhook-url` → Webhook Setup
- `PUT /api/contacts` → Create or Update Contact
- `PUT /api/groups/{groupId}/participants/update` → Update Group Participants
- `PUT /api/groups/{groupJid}/settings` → Update Group Settings
- `PUT /api/messages/{msgId}` → Edit a Message
- `PUT /api/whatsapp-sessions/{whatsappSession}` → Update WhatsApp Session
