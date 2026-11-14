const firebaseConfig = {
  apiKey: "AIzaSyD0yEF6vqBOY0zacQAYB7Qw2WxEEYN-ziM",
  authDomain: "nokotpotp.firebaseapp.com",
  databaseURL: "https://nokotpotp-default-rtdb.firebaseio.com",
  projectId: "nokotpotp",
  storageBucket: "nokotpotp.firebasestorage.app",
  messagingSenderId: "489887988168",
  appId: "1:489887988168:web:08f9e3bf8509ccf8a4a8fd",
};

firebase.initializeApp(firebaseConfig);

const firebaseAuth = firebase.auth();
const firebaseDB   = firebase.database();
