// App Check reCAPTCHA v3 SITE key (public — it's meant to ship in the page;
// the paired secret key stays in the Firebase console). Until this is set,
// App Check is completely inert.
//   Firebase console → App Check → Apps → register this web app with
//   reCAPTCHA v3 → paste the site key here.
// Then watch App Check → APIs → Cloud Functions until verified requests are
// ~100%, and only then flip ENFORCE_APP_CHECK in functions/src/config.ts.
window.VF_APPCHECK_SITE_KEY = null;

window.VF_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCzpvgL1Ez6-6T6mEewZWHMfseWizD4HWU",
  authDomain: "vault-fantasy.firebaseapp.com",
  projectId: "vault-fantasy",
  storageBucket: "vault-fantasy.firebasestorage.app",
  messagingSenderId: "196250681645",
  appId: "1:196250681645:web:674b28b1df98dab70913a4",
  measurementId: "G-E2XHWWQDEQ"
};
