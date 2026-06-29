const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const Airtable = require("airtable");
const twilio = require("twilio");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const CALENDLY_LINK = process.env.CALENDLY_LINK;
const TABLE_NAME = process.env.TABLE_NAME;

const CALENDLY_API_BASE = "https://api.calendly.com";
const CALENDLY_PAT = process.env.CALENDLY_PAT;
const CALENDLY_ORGANIZATION_URI = process.env.CALENDLY_ORGANIZATION_URI || "";

const base = new Airtable({
apiKey: process.env.AIRTABLE_API_KEY,
}).base(process.env.AIRTABLE_BASE_ID);

let twilioClient = null;

if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
twilioClient = twilio(
process.env.TWILIO_ACCOUNT_SID,
process.env.TWILIO_AUTH_TOKEN
);
}

const users = {};

app.get("/", (req, res) => {
res.send("WhatsApp bot is running");
});

app.post("/whatsapp", handleWhatsApp);

app.get("/sync-calendly", async (req, res) => {
try {
const result = await syncCalendlyBookings();

return res.json({
success: true,
...result,
});
} catch (error) {
console.error("Calendly sync error:", error.message);

return res.status(500).json({
success: false,
error: error.message,
});
}
});

function createNewUser() {
return {
step: "start",
intent: "",
budget: null,
location: "",
propertyType: "",
timeline: "",
clientName: "",
email: "",
qualified: false,
saved: false,
followUpSent: false,
};
}

function handleWhatsApp(req, res) {
console.log("HANDLE WHATSAPP CALLED");

const from = req.body.WaId || req.body.From || "unknown";
const msg = (req.body.Body || "").trim();
const text = msg.toLowerCase();

if (!users[from] || text === "reset") {
users[from] = createNewUser();

if (text === "reset") {
return sendReply(res, "Reset done. Type Hi to start again.");
}
}

const user = users[from];
let reply = "";

console.log("STEP:", user.step);
console.log("TEXT:", text);
console.log("USER:", user);

if (user.step === "start") {
reply = "Hey! Are you looking to Buy, Sell, or Rent a property?";
user.step = "intent";
} else if (user.step === "intent") {
if (text.includes("buy")) {
user.intent = "buy";
reply = "Great! What budget are you working with?";
user.step = "budget";
} else if (
text.includes("rent") ||
text.includes("rental") ||
text.includes("lease")
) {
user.intent = "rent";
reply = "Great! What monthly rental budget are you working with?";
user.step = "budget";
} else if (text.includes("sell")) {
user.intent = "sell";
reply =
"Got it! What type of property are you selling?\n\nApartment\nVilla\nOffice\nLand";
user.step = "property_type";
} else {
reply = "Please reply with Buy, Sell, or Rent.";
}
} else if (user.step === "budget") {
user.budget = parseBudget(msg);
reply = "Nice! Which city or area are you interested in?";
user.step = "location";
} else if (user.step === "location") {
user.location = msg;
reply =
"What type of property are you looking for?\n\nApartment\nVilla\nOffice\nLand";
user.step = "property_type";
} else if (user.step === "property_type") {
user.propertyType = msg;

if (user.intent === "sell") {
reply = "Which city or area is the property located in?";
user.step = "seller_location";
} else {
reply = "Are you looking to move soon or just exploring?";
user.step = "timeline";
}
} else if (user.step === "seller_location") {
user.location = msg;
reply = "What is your expected selling price?";
user.step = "seller_price";
} else if (user.step === "seller_price") {
user.budget = parseBudget(msg);
reply = "Are you looking to sell soon or just exploring?";
user.step = "timeline";
} else if (user.step === "timeline") {
user.timeline = msg;

const serious =
text.includes("soon") ||
text.includes("asap") ||
text.includes("ready") ||
text.includes("now") ||
text.includes("yes") ||
text.includes("immediately") ||
text.includes("1-3") ||
text.includes("move soon") ||
text.includes("sell soon");

user.qualified = serious;

if (serious) {
reply =
"Perfect! Before I connect you with an agent, what name should our property advisor use when contacting you?";
user.step = "client_name";
} else {
user.step = "done";
saveLeadToAirtable(user, from);
reply = "No problem. Reach out anytime when you're ready.";
}
} else if (user.step === "client_name") {
user.clientName = msg;
reply = "Great! What's the best email address to reach you?";
user.step = "email";
} else if (user.step === "email") {
const email = msg.trim();

if (!email.includes("@") || !email.includes(".")) {
reply = "Please enter a valid email address.";
} else {
user.email = email;
user.step = "done";

saveLeadToAirtable(user, from);

reply = `Perfect! Let's schedule the right next step: ${getCalendlyLink(
user.intent
)}`;

scheduleFollowUp(from, user);
}
} else {
if (text === "hi" || text === "hello" || text === "start") {
users[from] = createNewUser();
reply = "Hey! Are you looking to Buy, Sell, or Rent a property?";
users[from].step = "intent";
} else {
reply = user.qualified
? `You can book here anytime: ${getCalendlyLink(user.intent)}`
: "Would you like to book a quick call?";
}
}

console.log("Reply:", reply);

return sendReply(res, reply);
}

function getCalendlyLink(intent) {
if (intent === "buy") {
return process.env.CALENDLY_BUY_LINK || CALENDLY_LINK;
}

if (intent === "sell") {
return process.env.CALENDLY_SELL_LINK || CALENDLY_LINK;
}

if (intent === "rent") {
return process.env.CALENDLY_RENT_LINK || CALENDLY_LINK;
}

return CALENDLY_LINK;
}

function calculateLeadScore(user) {
let score = 0;

if (user.intent === "buy") score += 30;
if (user.intent === "sell") score += 25;
if (user.intent === "rent") score += 20;
if (user.budget) score += 20;
if (user.location) score += 10;
if (user.propertyType) score += 10;
if (user.clientName) score += 5;
if (user.email) score += 5;

const timeline = String(user.timeline || "").toLowerCase();

if (
timeline.includes("soon") ||
timeline.includes("asap") ||
timeline.includes("immediately") ||
timeline.includes("now")
) {
score += 40;
}

let status = "COLD";

if (score >= 80) {
status = "HOT 🔥";
} else if (score >= 50) {
status = "WARM 🟡";
}

return { score, status };
}

function saveLeadToAirtable(user, phone) {
if (user.saved) return;

const lead = calculateLeadScore(user);

const note =
lead.score >= 90
? "HOT lead. Contact immediately."
: lead.score >= 70
? "Qualified lead. Follow up within 48h."
: "Nurture lead.";

let pipelineStage = "New Lead";

if (lead.score >= 90) {
pipelineStage = "Hot Lead";
} else if (lead.score >= 70) {
pipelineStage = "Qualified";
}

const activityEntry = `
${new Date().toLocaleString()}
Client Name: ${user.clientName || ""}
Email: ${user.email || ""}
Intent: ${user.intent || ""}
Budget: ${user.budget || ""}
Location: ${user.location || ""}
Property: ${user.propertyType || ""}
Timeline: ${user.timeline || ""}
Score: ${lead.score}
Status: ${lead.status}
------------------------
`;

const nextFollowUp = new Date();
nextFollowUp.setDate(nextFollowUp.getDate() + 2);

const cleanPhone = String(phone).replace("whatsapp:", "");
const escapedPhone = cleanPhone.replace(/'/g, "\\'");

const fields = {
Phone: cleanPhone,
"Client Name": user.clientName || "",
Email: user.email || "",
Intent: user.intent,
Location: user.location,
Timeline: user.timeline,

"Lead Score": lead.score,
"Lead Status": lead.status,
"Pipeline Stage": pipelineStage,
"Agent Status": "New",

"Lead Owner": "Salman",
"Last Contacted": new Date().toISOString(),
"Next Follow Up": nextFollowUp.toISOString(),

Notes: note,
"Activity Log": activityEntry,
};

if (user.propertyType) {
fields["Property Type"] = user.propertyType;
}

if (user.budget !== null && !Number.isNaN(user.budget)) {
fields.Budget = user.budget;
}

base(TABLE_NAME)
.select({
maxRecords: 1,
filterByFormula: `{Phone} = '${escapedPhone}'`,
})
.firstPage(function (searchErr, records) {
if (searchErr) {
console.error("Airtable search error:", searchErr);
return;
}

if (records.length > 0) {
const recordId = records[0].id;

base(TABLE_NAME).update(
[
{
id: recordId,
fields,
},
],
function (updateErr, updatedRecords) {
if (updateErr) {
console.error("Airtable update error:", updateErr);
return;
}

user.saved = true;
console.log("Lead updated:", updatedRecords[0].id);
}
);
} else {
base(TABLE_NAME).create(
[
{
fields,
},
],
function (createErr, createdRecords) {
if (createErr) {
console.error("Airtable create error:", createErr);
return;
}

user.saved = true;
console.log("Lead created:", createdRecords[0].id);
}
);
}
});
}

function scheduleFollowUp(to, user) {
console.log("SCHEDULE FOLLOWUP STARTED", to);

if (!twilioClient) {
console.error("FOLLOW-UP ERROR: Twilio client not configured");
return;
}

setTimeout(() => {
if (user.followUpSent) return;

const calendlyLink = getCalendlyLink(user.intent);

const followUpMessage = `Quick follow-up — are you still interested in scheduling a quick call?

You can book here anytime:
${calendlyLink}`;

const cleanTo = String(to).replace("whatsapp:", "");
const whatsappTo = cleanTo.startsWith("+")
? `whatsapp:${cleanTo}`
: `whatsapp:+${cleanTo}`;

console.log("TRYING TO SEND FOLLOW-UP TO:", whatsappTo);

twilioClient.messages
.create({
from: process.env.TWILIO_WHATSAPP_FROM,
to: whatsappTo,
body: followUpMessage,
})
.then((message) => {
user.followUpSent = true;
console.log("FOLLOW-UP SENT:", message.sid);
})
.catch((err) => {
console.error("FOLLOW-UP ERROR:", err.message);
});
}, 24 * 60 * 60 * 1000);
}

async function calendlyRequest(path) {
if (!CALENDLY_PAT) {
throw new Error("CALENDLY_PAT is missing");
}

const res = await fetch(`${CALENDLY_API_BASE}${path}`, {
headers: {
Authorization: `Bearer ${CALENDLY_PAT}`,
"Content-Type": "application/json",
},
});

if (!res.ok) {
const text = await res.text();
throw new Error(`Calendly API error ${res.status}: ${text}`);
}

return res.json();
}

async function getCalendlyOrganizationUri() {
if (CALENDLY_ORGANIZATION_URI) {
return CALENDLY_ORGANIZATION_URI;
}

const me = await calendlyRequest("/users/me");

const organizationUri =
me.resource.current_organization ||
me.resource.organization ||
"";

if (!organizationUri) {
throw new Error("Calendly organization URI not found from /users/me.");
}

return organizationUri;
}

async function syncCalendlyBookings() {
console.log("SYNC CALENDLY STARTED");

const organizationUri = await getCalendlyOrganizationUri();

const now = new Date();
const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const to = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

const eventsData = await calendlyRequest(
`/scheduled_events?organization=${encodeURIComponent(
organizationUri
)}&min_start_time=${from.toISOString()}&max_start_time=${to.toISOString()}&status=active&sort=start_time:asc&count=100`
);

const events = eventsData.collection || [];
let checked = 0;
let updated = 0;

for (const event of events) {
const eventUuid = String(event.uri).split("/").pop();

const inviteesData = await calendlyRequest(
`/scheduled_events/${eventUuid}/invitees?status=active&count=100`
);

const invitees = inviteesData.collection || [];

for (const invitee of invitees) {
checked++;

const didUpdate = await updateLeadBookingByEmail({
email: invitee.email,
inviteeName: invitee.name,
eventUri: event.uri,
inviteeUri: invitee.uri,
startTime: event.start_time,
eventName: event.name,
});

if (didUpdate) {
updated++;
}
}
}

console.log("SYNC CALENDLY DONE", {
checked,
updated,
});

return {
checked,
updated,
};
}

function updateLeadBookingByEmail({
email,
inviteeName,
eventUri,
inviteeUri,
startTime,
eventName,
}) {
return new Promise((resolve) => {
if (!email) {
return resolve(false);
}

const safeEmail = String(email).toLowerCase().replace(/'/g, "\\'");

base(TABLE_NAME)
.select({
maxRecords: 1,
filterByFormula: `LOWER({Email}) = '${safeEmail}'`,
})
.firstPage(function (searchErr, records) {
if (searchErr) {
console.error("Airtable booking search error:", searchErr);
return resolve(false);
}

if (!records.length) {
console.log("No Airtable lead found for Calendly email:", email);
return resolve(false);
}

const record = records[0];
const existingCalendlyUri = record.get("Calendly URI");

if (
existingCalendlyUri === inviteeUri ||
existingCalendlyUri === eventUri
) {
console.log("Booking already synced:", email);
return resolve(false);
}

const existingLog = record.get("Activity Log") || "";

const bookingEntry = `
${new Date().toLocaleString()}
Booking Confirmed
Name: ${inviteeName || ""}
Email: ${email || ""}
Event: ${eventName || ""}
Booking Time: ${startTime || ""}
Calendly Event URI: ${eventUri || ""}
Calendly Invitee URI: ${inviteeUri || ""}
------------------------
`;

base(TABLE_NAME).update(
[
{
id: record.id,
fields: {
"Booking Status": "Booked",
"Booking Time": startTime,
"Calendly Email": email,
"Calendly Event ID": eventUri,
"Calendly URI": inviteeUri || eventUri,
"Viewing Booked": true,
"Viewing Date": startTime,
"Pipeline Stage": "Appointment Booked",
"Agent Status": "Booked",
"Activity Log": `${existingLog}\n${bookingEntry}`,
},
},
],
function (updateErr) {
if (updateErr) {
console.error("Airtable booking update error:", updateErr);
return resolve(false);
}

console.log("Booking synced to Airtable:", email);
return resolve(true);
}
);
});
});
}

function parseBudget(value) {
const clean = String(value).toLowerCase().replace(/,/g, "").trim();

if (clean.includes("k")) {
return Number(clean.replace(/[^\d.]/g, "")) * 1000;
}

if (clean.includes("m")) {
return Number(clean.replace(/[^\d.]/g, "")) * 1000000;
}

return Number(clean.replace(/[^\d.]/g, ""));
}

function sendReply(res, reply) {
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
<Message>${escapeXml(reply)}</Message>
</Response>`;

res.writeHead(200, { "Content-Type": "text/xml" });
res.end(xml);
}

function escapeXml(value) {
return String(value)
.replace(/&/g, "&amp;")
.replace(/</g, "&lt;")
.replace(/>/g, "&gt;")
.replace(/"/g, "&quot;")
.replace(/'/g, "&apos;");
}

app.post("/webhook/calendly", (req, res) => {
console.log("Calendly webhook received:", req.body);
return res.status(200).send("Calendly webhook received");
});

console.log("REACHED END OF FILE");

app.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);

setInterval(() => {
syncCalendlyBookings().catch((error) => {
console.error("Scheduled Calendly sync failed:", error.message);
});
}, 5 * 60 * 1000);
});




