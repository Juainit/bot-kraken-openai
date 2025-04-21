const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function getVolatility() {
  console.log("📡 Obteniendo lista de pares...");

  const assetPairsRes = await fetch("https://api.kraken.com/0/public/AssetPairs");
  const assetPairsData = await assetPairsRes.json();
  const entries = Object.entries(assetPairsData.result);

  const eurUsdPairs = entries.filter(([key, val]) =>
    val.altname.endsWith("EUR") || val.altname.endsWith("USD")
  );

  const results = [];

  for (let i = 0; i < eurUsdPairs.length; i++) {
    const [key, val] = eurUsdPairs[i];
    const displayName = val.altname;
    process.stdout.write(`\r🔄 ${i + 1}/${eurUsdPairs.length} - ${displayName.padEnd(10)}`);

    try {
      const ohlcRes = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${key}&interval=1440`);
      const ohlcData = await ohlcRes.json();
      const data = ohlcData.result[key];

      if (!Array.isArray(data)) continue;

      const variations = data.map(([time, open, high, low, close]) => {
        const h = parseFloat(high);
        const l = parseFloat(low);
        return ((h - l) / l) * 100;
      }).filter(Boolean);

      if (variations.length > 0) {
        const avg = variations.reduce((a, b) => a + b, 0) / variations.length;
        results.push({ pair: displayName, volatility: avg });
      }
    } catch (e) {
      continue;
    }

    await new Promise(r => setTimeout(r, 600));
  }

  console.log("\n📊 Top 30 pares más volátiles:");
  results
    .sort((a, b) => b.volatility - a.volatility)
    .slice(0, 30)
    .forEach(r => {
      console.log(`• ${r.pair.padEnd(10)} → ${r.volatility.toFixed(2)}%`);
    });
}

getVolatility();