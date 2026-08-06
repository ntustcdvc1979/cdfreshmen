// ============================================================
//  Firebase 設定
//  ------------------------------------------------------------
//  到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → SDK 設定和配置
//  把那段 firebaseConfig 的內容整個貼到下面覆蓋掉。
//
//  ※ 這些金鑰本來就是公開的（會被瀏覽器下載），不是機密。
//    真正的保護來自 Realtime Database 的安全性規則（見 README.md）。
// ============================================================

export const firebaseConfig = {
  apiKey: "請填入",
  authDomain: "請填入.firebaseapp.com",
  databaseURL: "https://請填入-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "請填入",
  storageBucket: "請填入.appspot.com",
  messagingSenderId: "請填入",
  appId: "請填入"
};
