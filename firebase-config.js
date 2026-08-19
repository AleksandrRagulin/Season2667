// Настройки общего хранилища (Firebase Realtime Database).
//
// Как получить свои значения:
// 1. Зайдите на https://console.firebase.google.com и создайте проект
//    (можно назвать так же — Season2627).
// 2. В разделе Build → Realtime Database нажмите "Create Database",
//    выберите любой регион и режим "Start in test mode".
// 3. После создания базы откройте вкладку Rules и замените правила на:
//      {
//        "rules": {
//          "predictions": {
//            ".read": true,
//            ".write": true
//          }
//        }
//      }
//    (доступ на чтение/запись открыт всем, кто знает адрес сайта —
//    как и было в Excel-таблице, без логина; этого достаточно для
//    закрытого круга друзей).
// 4. В настройках проекта (шестерёнка → Project settings → Your apps)
//    добавьте веб-приложение (</> Web) и скопируйте объект firebaseConfig.
// 5. Вставьте скопированные значения вместо плейсхолдеров ниже и
//    закоммитьте файл — секретов тут нет, конфиг Firebase для веба
//    не является приватным ключом, безопасность обеспечивают Rules.
//
// Пока значения не заполнены, сайт работает локально
// (localStorage), без общей синхронизации между участниками.

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDco3qE6RGEAv465-W1DXrPe8bk9R63aME",
  authDomain: "footanal2667.firebaseapp.com",
  databaseURL: "https://footanal2667-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "footanal2667",
  storageBucket: "footanal2667.firebasestorage.app",
  messagingSenderId: "133942305859",
  appId: "1:133942305859:web:b3b6f694bb0ef01260a0f6"
};
