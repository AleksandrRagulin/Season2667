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
  apiKey: "ВСТАВЬТЕ_apiKey",
  authDomain: "ВАШ_ПРОЕКТ.firebaseapp.com",
  databaseURL: "https://ВАШ_ПРОЕКТ-default-rtdb.firebaseio.com",
  projectId: "ВАШ_ПРОЕКТ",
  storageBucket: "ВАШ_ПРОЕКТ.appspot.com",
  messagingSenderId: "ВСТАВЬТЕ_messagingSenderId",
  appId: "ВСТАВЬТЕ_appId"
};
