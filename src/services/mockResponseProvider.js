const fallbackResponse =
  "I'm happy to help. Could you share a little more about what you'd like to know—courses, admissions, fees, scholarships, placements, or speaking with a counsellor?";

const normalize = (value) => String(value || "")
  .toLowerCase()
  .replace(/(.)\1{2,}/g, "$1$1")
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const makeIntent = (name, phrases, response, keywords = [], priority = 0) => ({
  name,
  phrases: phrases.map(normalize),
  keywords: keywords.map(normalize),
  response,
  priority,
});

const intents = [
  makeIntent("mba-fees", ["mba fees", "fees for mba", "mba fee"], "MBA fee information depends on the specific program and intake. Please share the MBA format or intake you are interested in, and our admissions team can guide you to the relevant details.", ["mba", "fee"], 120),
  makeIntent("course-fees", ["course fees", "tuition fees", "fees", "fee structure", "price"], "Course fees depend on the program you choose. Tell me the course you're interested in, such as MBA, BBA or BCA, and I'll guide you to the relevant fee information.", ["fee"], 80),
  makeIntent("admission-process", ["how to get admission", "how can i get admission", "admission process", "how do i apply", "application process", "admission kaise hoga", "admission kaise milega", "how can i take admission"], "Absolutely. Our admission process is simple: choose your preferred program, check the eligibility requirements, complete the application form, upload the required documents, and submit your application. I'd be happy to guide you through the process step by step.", ["admission"], 110),
  makeIntent("application-deadline", ["application deadline", "last date to apply", "admission dates", "when is the last date", "deadline"], "Application deadlines can vary by program and intake. Please tell me which program you are considering so the admissions team can guide you with the applicable date.", ["application", "deadline"], 105),
  makeIntent("admission-requirements", ["admission requirements", "eligibility", "what is the eligibility", "eligibility criteria"], "Eligibility and admission requirements depend on the program. Share the program you are interested in, and I can help you identify the requirements and next steps.", ["eligibility"], 100),
  makeIntent("hi", ["hi", "hi there"], "Hi! 👋 Welcome to {name}. How can I help you today?"),
  makeIntent("hello", ["hello", "hello there"], "Hello! 👋 Welcome to {name}. What would you like to explore today?"),
  makeIntent("hey", ["hey", "hey there"], "Hey! 👋 I’m here to help with courses, admissions and student queries."),
  makeIntent("good-morning", ["good morning"], "Good morning! 👋 How can I help you explore your study options today?"),
  makeIntent("good-afternoon", ["good afternoon"], "Good afternoon! How can I help you with your admissions journey?"),
  makeIntent("how-are-you", ["how are you", "how are you doing"], "I’m doing well, thank you! I’m ready to help with courses, admissions, fees and more."),
  makeIntent("who-are-you", ["who are you", "what are you"], "I’m the {name} admissions assistant. I can help you explore programs and understand the next steps."),
  makeIntent("what-can-you-do", ["what can you do", "how can you help"], "I can help you explore courses, eligibility, admissions, fees, scholarships, campus facilities, placements and counsellor support."),
  makeIntent("about-assistant", ["tell me about yourself", "tell me about you"], "I’m the {name} virtual admissions assistant, here to help you find the right information and next step."),
  makeIntent("thank-you", ["thank you", "thankyou"], "You’re welcome! I’m happy to help. Feel free to ask another question."),
  makeIntent("thanks", ["thanks", "thx"], "You’re welcome! Let me know if there is anything else I can help with."),
  makeIntent("bye", ["bye", "goodbye", "see you"], "Goodbye! Best wishes for your admissions journey. You’re welcome to return whenever you need help."),
  makeIntent("courses", ["courses", "what courses do you offer", "which courses are available"], "We offer a range of undergraduate and postgraduate programs across business, technology and related disciplines. Tell me which area you're interested in, and I can help you explore the available programs.", ["course"], 70),
  makeIntent("programs", ["programs", "what programs do you offer", "available programs"], "We offer a range of undergraduate and postgraduate programs. Tell me your preferred area of study, and I can help you explore the available programs.", ["program"], 65),
  makeIntent("undergraduate-courses", ["undergraduate courses", "undergraduate programs", "ug courses"], "Our undergraduate options are designed to build strong academic and practical foundations. Tell me your area of interest, and I can guide you to suitable programs.", ["undergraduate"], 75),
  makeIntent("postgraduate-courses", ["postgraduate courses", "postgraduate programs", "pg courses"], "Our postgraduate options support advanced learning and career development. Tell me your preferred subject area, and I can guide you further.", ["postgraduate"], 75),
  makeIntent("mba", ["mba", "master of business administration"], "MBA is a postgraduate business program focused on management and professional development. Tell me whether you need eligibility, fees or admission guidance.", ["mba"], 60),
  makeIntent("bba", ["bba", "bachelor of business administration"], "BBA is an undergraduate business program that develops foundations in management and related disciplines. I can help with eligibility, fees or admission steps.", ["bba"], 60),
  makeIntent("bca", ["bca", "bachelor of computer applications"], "BCA is an undergraduate program focused on computer applications and technology foundations. I can help with eligibility, fees or admission steps.", ["bca"], 60),
  makeIntent("scholarship", ["scholarship", "scholarships available", "financial assistance", "financial aid"], "Scholarship and financial-assistance availability can depend on the program and applicant profile. Please share your program of interest so a counsellor can guide you.", ["scholarship"], 90),
  makeIntent("hostel", ["hostel", "hostel facility", "is hostel available", "hostel available"], "Hostel availability and facilities can vary by campus and intake. Please share your program or campus preference so our team can guide you accurately.", ["hostel"], 90),
  makeIntent("campus", ["campus", "campus facilities", "campus life"], "I can help you learn more about campus facilities and student life. Tell me what facility or campus detail you would like to know about.", ["campus"], 70),
  makeIntent("placement", ["placement", "placements", "career opportunities", "career support"], "Career and placement support can vary by program. Tell me the course you are considering, and I can help you identify the right questions for the admissions team.", ["placement", "career"], 85),
  makeIntent("contact-admission-office", ["contact admission office", "admission office contact", "contact admissions"], "I can help connect you with the admissions office. Please share your name and preferred contact details, or choose the counsellor option available in the widget.", ["contact", "admission"], 95),
  makeIntent("talk-to-counsellor", ["talk to counsellor", "talk to a counsellor", "speak to counsellor", "connect me to counsellor"], "Of course. I can help connect you with an admissions counsellor. Please share your name and preferred contact details, or choose the counsellor option available in the widget.", ["counsellor"], 100),
  makeIntent("counselling", ["counselling", "counseling", "need counselling", "need counseling"], "I can help arrange admissions counselling. Tell me which program you are considering and a counsellor can guide you through the next steps.", ["counselling"], 80),
  makeIntent("documents", ["documents required", "required documents", "what documents do i need"], "Common application steps may include submitting identity, academic and contact details. The exact document list depends on the program, so a counsellor can confirm it for you.", ["document"], 85),
  makeIntent("entrance-exam", ["entrance exam", "entrance test", "is there an entrance exam"], "Entrance-exam requirements can depend on the program and intake. Tell me the program you are interested in, and I can help you check the next step.", ["entrance", "exam"], 85),
  makeIntent("application-status", ["application status", "check my application", "track my application"], "I can help you understand the application-status process. Please keep your application reference details ready and contact the admissions team for an account-specific update.", ["application", "status"], 90),
  makeIntent("location", ["location", "where are you located", "campus location", "where is the campus"], "I can help with campus-location information. Please tell me which campus or program you are asking about so the right details can be shared.", ["location"], 80),
  makeIntent("international-students", ["international students", "international student admission", "can international students apply"], "International-admission requirements can differ by program and applicant location. Please share your intended program and country so the admissions team can guide you.", ["international"], 90),
  makeIntent("greeting-hello-there", ["hello friend", "hello assistant"], "Hello! 👋 Welcome to {name}. What would you like to explore today?"),
  makeIntent("greeting-hey-there", ["hey assistant", "hey friend"], "Hey! 👋 I’m here to help with courses, admissions and student queries."),
  makeIntent("course-offerings", ["course offerings", "available courses"], "We offer a range of undergraduate and postgraduate programs. Tell me which area you are interested in, and I can help you explore the available options."),
  makeIntent("program-offerings", ["program offerings", "available programs list"], "We offer a range of programs across business, technology and related disciplines. Tell me your preferred area of study, and I can guide you further."),
  makeIntent("undergraduate", ["ug program", "bachelor programs"], "Our undergraduate options are designed to build strong academic and practical foundations. Tell me your area of interest, and I can guide you to suitable programs."),
  makeIntent("postgraduate", ["pg program", "masters programs"], "Our postgraduate options support advanced learning and career development. Tell me your preferred subject area, and I can guide you further."),
  makeIntent("mba-overview", ["about mba", "mba program"], "MBA is a postgraduate business program focused on management and professional development. Tell me whether you need eligibility, fees or admission guidance.", ["mba"], 55),
  makeIntent("bba-overview", ["about bba", "bba program"], "BBA is an undergraduate business program that develops foundations in management and related disciplines. I can help with eligibility, fees or admission steps.", ["bba"], 55),
  makeIntent("bca-overview", ["about bca", "bca program"], "BCA is an undergraduate program focused on computer applications and technology foundations. I can help with eligibility, fees or admission steps.", ["bca"], 55),
  makeIntent("tuition", ["tuition", "tuition cost"], "Tuition fees depend on the program you choose. Tell me the course you are interested in, and I'll guide you to the relevant fee information.", ["tuition"], 70),
  makeIntent("scholarship-availability", ["scholarship options", "financial support"], "Scholarship and financial-assistance availability can depend on the program and applicant profile. Please share your program of interest so a counsellor can guide you."),
  makeIntent("hostel-availability", ["hostel availability", "hostel options"], "Hostel availability and facilities can vary by campus and intake. Please share your program or campus preference so our team can guide you accurately."),
  makeIntent("career-support", ["career support", "placement support"], "Career and placement support can vary by program. Tell me the course you are considering, and I can help you identify the right questions for the admissions team."),
  makeIntent("admission-dates", ["when do admissions open", "admission opening date"], "Admission dates can vary by program and intake. Please tell me which program you are considering so the admissions team can guide you with the applicable schedule."),
];

function scoreIntent(intent, normalizedText) {
  let score = 0;
  let matched = false;
  for (const phrase of intent.phrases) {
    if (normalizedText === phrase) {
      matched = true;
      score = Math.max(score, 1000 + phrase.length);
    } else if (normalizedText.includes(phrase)) {
      matched = true;
      score = Math.max(score, 600 + phrase.length);
    }
  }
  if (intent.keywords.length && intent.keywords.every((keyword) => normalizedText.includes(keyword))) {
    matched = true;
    score = Math.max(score, 300 + intent.keywords.join(" ").length);
  }
  return matched ? score + intent.priority : 0;
}

export function generateMockResponse({ message, chatbotName }) {
  const normalizedText = normalize(message);
  let matchedIntent = null;
  let highestScore = 0;
  for (const intent of intents) {
    const score = scoreIntent(intent, normalizedText);
    if (score > highestScore) {
      matchedIntent = intent;
      highestScore = score;
    }
  }
  const response = matchedIntent?.response || fallbackResponse;
  return {
    intent: matchedIntent?.name || "fallback",
    reply: response.replaceAll("{name}", chatbotName || "our university"),
  };
}

export { fallbackResponse, intents, normalize };
