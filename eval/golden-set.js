// Golden set for eyeballing prompt quality. Each entry is a sample post plus
// optional context. Add real posts you want to regression-test here.
//   text   — the post body (as extractText() would hand it to the engine)
//   author — optional poster name (tests the findAuthor path)
//   note   — what this case is probing (fluff level, language, edge case)
window.MLL_GOLDEN = [
  {
    note: 'PURE fluff, name only in header (author path)',
    author: 'Dana Levi',
    text:
      'I am beyond thrilled and humbled to share some incredibly exciting news that has been months in the ' +
      'making! 🎉🚀 After a transformational journey full of growth and late nights, I have officially accepted ' +
      'a new role as Senior Product Manager at Acme. None of this would have been possible without my mentors ' +
      'and family. Onwards and upwards! 🙏 #blessed #newbeginnings',
  },
  {
    note: 'HIGH fluff with a concrete fact buried inside',
    author: 'Ravi Menon',
    text:
      "Grateful doesn't even begin to describe it. 🙏 Today we announce that our little startup just closed a " +
      '$2M seed round led by Foobar Ventures. To every single person who believed in the dream — this is yours ' +
      'too. The journey is just beginning. 🚀 #startup #funding',
  },
  {
    note: 'MEDIUM fluff, real news',
    author: 'Sara Klein',
    text:
      'Excited to share that our team just shipped v3 of the analytics SDK — 40% faster cold start and a new ' +
      'streaming API. Huge thanks to the engineers who made it happen. Link in comments.',
  },
  {
    note: 'LOW fluff / already terse (should barely change)',
    author: 'Tom Reyes',
    text: 'We are hiring two backend engineers in Berlin. Go, Kubernetes, remote-friendly. DM me.',
  },
  {
    note: 'Sensitive: layoff — guardrail must keep tone kind',
    author: 'Maya Gordon',
    text:
      'After 6 wonderful years, I was let go this week as part of a company-wide layoff. It stings, but I am ' +
      'proud of what we built and open to what is next — reach out if you know of product roles.',
  },
  {
    note: 'Hebrew, HIGH fluff (should be rewritten IN Hebrew)',
    author: 'דנה לוי',
    text:
      'אני נרגשת עד עמקי נשמתי לחלוק חדשות מרעישות! 🎉 אחרי מסע מטלטל של צמיחה ולילות לבנים, התקבלתי לתפקיד ' +
      'מנהלת מוצר בכירה ב-Acme. תודה למנטורים, למשפחה ולכל מי שהאמין. קדימה ולמעלה! 🙏 #מבורכת',
  },
  {
    note: 'French — must be rewritten IN French, not translated to English (fix #1)',
    author: 'Camille Laurent',
    text:
      "Ravie de vous annoncer que je rejoins Acme en tant que Directrice Produit ! Un immense merci à toutes les " +
      "personnes qui m'ont accompagnée dans cette aventure. Hâte de commencer ce nouveau chapitre. 🚀",
  },
  {
    note: 'Spanish — must be rewritten IN Spanish (fix #1)',
    author: 'Carlos Ruiz',
    text:
      '¡Estoy encantado de compartir que hemos cerrado nuestra primera ronda de inversión de 2 millones de ' +
      'euros! Gracias a todo el equipo por su esfuerzo incansable. Esto no ha hecho más que empezar. 🙌',
  },
];
