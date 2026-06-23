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

// app.post("/", handleWhatsApp);
app.post("/whatsapp", handleWhatsApp);

function handleWhatsApp(req, res) {
console.log("HANDLE WHATSAPP CALLED");

const from = req.body.WaId || req.body.From || "unknown";
const msg = (req.body.Body || "").trim();
const text = msg.toLowerCase();

console.log("FROM KEY:", from);
console.log("BODY:", msg);
console.log("CURRENT USERS:", users);


if (!users[from] || text === "reset") {
users[from] = {
step: "start",
intent: "",
budget: null,
location: "",
propertyType: "",
timeline: "",
qualified: false,
saved: false,
followUpSent: false,
};

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
user.step = "done";

saveLeadToAirtable(user, from);

if (serious) {
reply = `Perfect! Let's schedule the right next step: ${getCalendlyLink(user.intent)}`;
scheduleFollowUp(from, user);
} else {
reply = "No problem. Reach out anytime when you're ready.";
}
} else {
if (
text === "hi" ||
text === "hello" ||
text === "start"
) {
users[from] = {
step: "start",
intent: "",
budget: null,
location: "",
timeline: "",
propertyType: "",
qualified: false,
saved: false,
followUpSent: false,
};

reply = "Hey! Are you looking to Buy, Sell, or Rent a property?";
} else {
reply = user.qualified
? `You can book here anytime: ${CALENDLY_LINK}`
: "Would you like to book a quick call?";
}
}


console.log("WhatsApp received:", msg);
console.log("From:", from);
console.log("User:", user);
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

if (user.intent === "buy") {
score += 30;
}

if (user.intent === "sell") {
score += 25;
}

if (user.intent === "rent") {
score += 20;
}

if (user.budget) {
score += 20;
}

if (user.location) {
score += 10;
}

if (user.propertyType) {
score += 10;
}

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

return {
score,
status,
};
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

console.log("Lead Owner =", "Salman");
console.log(fields);

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

if (lead.score >= 90 && !user.followUpSent) {
scheduleFollowUp(phone, user);
}
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

if (lead.score >= 90 && !user.followUpSent) {
scheduleFollowUp(phone, user);
}

});
}

});
}


function scheduleFollowUp(to, user) {
console.log("SCHEDULE FOLLOWUP STARTED", to);

setTimeout(() => {
if (user.followUpSent) return;

const calendlyLink = getCalendlyLink(user.intent);

const followUpMessage =
`Quick follow-up — are you still interested in scheduling a quick call?

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
const event = req.body;

const payload = event.payload || {};
const invitee = payload.invitee || {};
const scheduledEvent = payload.scheduled_event || {};

const email = invitee.email || "";
const startTime = scheduledEvent.start_time || "";
const eventId = scheduledEvent.uri || "";

console.log("Calendly booking:", {
email,
startTime,
eventId,
});

return res.status(200).send("Calendly webhook received");
});

console.log("REACHED END OF FILE");
app.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
});
