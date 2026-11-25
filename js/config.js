// Единственное место с идентификаторами моделей и ограничениями.
export const CONFIG = {
  api: 'https://openrouter.ai/api/v1',
  models: {
    author: 'anthropic/claude-sonnet-5.5',   // карта фактов, вопросы, сценарий лекции
    checker: 'anthropic/claude-haiku-5.5',   // слепая проверка
    voice: 'google/gemini-3.8-flash-tts',
  },
  voiceName: 'Sulafat',
  oauth: { keyLabel: 'zachet', limit: '5', expiration: '30-days' },
  parallel: 4,          // одновременных запросов к моделям текста
  voiceParallel: 3,     // одновременных запросов озвучки
  reserve: 0.1,         // запас вопросов
  counts: [20, 30, 35],
  demoReady: false,     // включить, когда в demo/ лежат банк вопросов и озвучка
  chunkChars: 5000,     // размер части лекции для карты фактов
  chunkImages: 6,
  visualTextLimit: 120, // меньше знаков на странице — отправляем её картинкой
  imageSide: 1100,
  timeoutMs: 180000,
  // Оценка стоимости озвучки: ответ со звуком цены не содержит.
  voicePrice: { tokensPerSecond: 25, perMillion: 9 },
  voice: { sampleRate: 24000 },
};
