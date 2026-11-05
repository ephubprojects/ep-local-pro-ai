// Firebase init — shared by all pages
// After creating Firebase project at console.firebase.google.com,
// replace these placeholder values with your actual config
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",
  authDomain:        "ep-local-pro-ai.firebaseapp.com",
  projectId:         "ep-local-pro-ai",
  storageBucket:     "ep-local-pro-ai.appspot.com",
  messagingSenderId: "REPLACE_WITH_SENDER_ID",
  appId:             "REPLACE_WITH_APP_ID"
};

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
