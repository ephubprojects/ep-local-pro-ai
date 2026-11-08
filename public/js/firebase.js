// Firebase init — shared by all pages
// After creating Firebase project at console.firebase.google.com,
// replace these placeholder values with your actual config
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage }     from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const firebaseConfig = {
  apiKey:            "AIzaSyB4M24fLSHNKdWRHDDu9xj2sPGYCDZExiA",
  authDomain:        "ep-local-pro-ai.firebaseapp.com",
  projectId:         "ep-local-pro-ai",
  storageBucket:     "ep-local-pro-ai.firebasestorage.app",
  messagingSenderId: "182127678437",
  appId:             "1:182127678437:web:073432114afc243b5d150c"
};

const app  = initializeApp(firebaseConfig);
export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);
