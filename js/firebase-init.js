// firebase-init.js — initialize Firebase app, auth, and Firestore with offline cache.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  signInWithEmailAndPassword, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBha2lna5MA_AzE5EfScLbWTEadVj6vzoA",
  authDomain: "note-aggregator.firebaseapp.com",
  projectId: "note-aggregator",
  storageBucket: "note-aggregator.firebasestorage.app",
  messagingSenderId: "985348478275",
  appId: "1:985348478275:web:1f91fd3ae65971546dcbf6",
};

const app = initializeApp(firebaseConfig);

let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  console.warn("Persistent local cache unavailable, falling back to memory cache:", e);
  // Fallback handled by Firestore default if needed
  const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  db = getFirestore(app);
}

const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export {
  app, auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  signInWithEmailAndPassword, updatePassword,
};
