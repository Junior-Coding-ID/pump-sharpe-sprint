// Pump.fun Sharpe Sprint — "Tetes Stabil" (Steady Drips)
// Paper-trading bot for agent-fun/replay/v2 (Node 22, stdin/stdout, hello/batch/done).
// Strategi orisinal: AKUMULASI MURNI + DUKUNGAN CREATOR.
// Ranking ditentukan Sharpe ratio per jam, BUKAN PnL liar — jadi bot ini mengejar
// round-trip kecil yang stabil dan disiplin, bukan sekali jackpot. 100% deterministik:
// tidak ada Date.now(), tidak ada Math.random() tanpa seed, semua keputusan hanya
// dari data batch (seq, slot, event, mark, fill) dan konstanta di bawah. Urutan
// iterasi selalu deterministik (sort eksplisit dengan tie-break nama mint).
//
// Mekanik biaya yang diperhitungkan (dari competition.yaml + protocol):
// - Fee kurva ~1.25% per sisi (protocol 95bps + creator 30bps) + tx fee 105.000 lamports
//   per order. Round trip di harga datar merugi ~2,9-4,6% tergantung ukuran posisi,
//   jadi take-profit harus jauh di atas itu dan stop-loss harus ketat.
// - Beli per mint per batch dibatasi 1% dari real SOL reserve (100bps) — ukuran posisi
//   menyesuaikan cap itu, dan beli < 0.01 SOL dilewati (tidak dihitung guardrail).
// - Maks 5 posisi terbuka; guardrail butuh round trip >= 0.01 SOL di >= 20 mint berbeda.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ konstanta strategi
// Ukuran posisi: 0.05 SOL per mint — kecil dan tetap, supaya 10 SOL modal bisa
// memutar puluhan round trip dan satu mint yang rug tidak menggoyang equity.
// Koin TANPA dukungan creator dibeli hanya 0,011 SOL (sedikit di atas minimum
// guardrail 0,01 SOL): mean gross mereka (+2,16%) di bawah fee round trip, jadi
// setiap SOL yang dipakai di sana merugi — ukuran minimum meminimalkan drag
// sambil tetap menambah jumlah mint demi guardrail 20 mint. Koin dukungan creator
// (mean gross +4,25%) dibeli sampai 0,05 SOL karena ekspektasi per SOL positif.
const POSITION_SIZE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
const BASE_SIZE_LAMPORTS = 11_000_000n;
// Beli minimum 0.01 SOL: di bawah itu round trip tidak dihitung guardrail 20 mint.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
// Slippage beli 10%: order diputuskan di slot s, fill di s+2; di v3, slippage 5%
// menolak fill tepat di koin yang masih memompa (seleksi merugikan: hanya koin
// yang sudah berhenti naik yang terisi). 10% membiarkan fill masuk mengikuti
// momentum sambil tetap menolak lonjakan ekstrem.
// Slippage jual 10%: LEBIH LONGGAR dengan sengaja — di v2, sell dengan slippage 3%
// berulang kali DITOLAK saat dump (fill lebih buruk dari ambang), sehingga posisi
// terus jatuh selagi sell di-retry tiap batch; exit yang terlaksana di -10% masih
// jauh lebih baik daripada exit yang tak pernah terlaksana.
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 1000;
// Maks 3 beli baru per batch: hemat slot posisi (maks 5) dan hindari over-trading.
const MAX_BUYS_PER_BATCH = 3;

// --- sinyal masuk: AKUMULASI MURNI + DUKUNGAN CREATOR (riset offline, 128.058 event) ---
// Semua sinyal reaktif berbasis harga (momentum susulan, dip-buy, trailing, dsb.)
// punya ekspektasi NEGATIF setelah latensi 2 slot: pompa pump.fun hanya bertahan
// ~2-5 trade dan fill kita mendarat sesudahnya. Satu-satunya keluarga sinyal yang
// bertahan: 10 trade pertama sebuah koin SEMUANYA beli (akumulasi murni, belum ada
// penjual) + real reserve >= 1 SOL — dan lebih kuat lagi bila creator sendiri yang
// paling banyak membeli di 10 trade itu (creator bought >= 0,3 SOL):
//   K10 murni            : mean gross +2,16%/trade (n=123/24 jam)
//   K10 + creator >=0,3  : mean gross +4,25%/trade (n=72/24 jam), TP20/SL5
// Koin yang lolos K10 murni tapi tanpa dukungan creator tetap dibeli (ukuran sama,
// dibatasi cap) karena jendela final hanya 6 jam: tanpa mereka jumlah mint bisa
// jatuh di bawah guardrail 20 mint. Fee round trip ~2,9-4,6% (kurva 2,5% + tx fee)
// membuat ekspektasi per trade tipis — strategi ini adalah seleksi ketat + disiplin
// keluar, bukan jaminan untung.
// Real reserve minimum 1 SOL juga menjamin cap beli (1% reserve) >= 0.01 SOL,
// yaitu ukuran round trip minimum guardrail.
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // 1 SOL real reserve
const FIRST_TRADES = 10; // jendela akumulasi: 10 trade pertama harus semuanya beli
const CREATOR_MIN_BUY_LAMPORTS = 300_000_000n; // 0,3 SOL dibeli creator di 10 trade pertama
// --- aturan keluar (disiplin, kunci profit kecil secara rutin) ---
// Take-profit koin dukungan creator +20% (mereka paling sering lanjut naik);
// koin biasa +15%. Stop-loss -5% untuk semua (di bawah itu noise dump 2 slot
// membuat exit terealisasi jauh lebih buruk). Batas pegang 300 batch: backstop
// anti bag-holder; riset menunjukkan hampir semua trade selesai (TP/SL) jauh
// sebelum itu.
const TAKE_PROFIT_BPS = 1500;
const TAKE_PROFIT_CREATOR_BPS = 2000;
const STOP_LOSS_BPS = 500;
const MAX_HOLD_BATCHES = 300;

// ------------------------------------------------------------------ state per mint
interface MintTrack {
  firstSeq: number; // seq batch saat mint pertama terlihat
  trades: number; // jumlah TradeEvent terlihat
  price: number; // harga terakhir (SOL per token)
  creator: string; // creator dari CreateEvent ('' bila tidak terlihat)
  buysFirst10: number; // jumlah beli di antara 10 trade pertama
  creatorBuyLamports: bigint; // SOL yang dibeli creator di 10 trade pertama
  evaluated: boolean; // keputusan masuk sudah dibuat (tepat saat trade ke-10)
}

interface OpenTrade {
  entrySeq: number; // seq batch saat posisi pertama tercatat
  takeProfitBps: number; // TP posisi ini (lebih longgar bila didukung creator)
}

const tracks = new Map<string, MintTrack>();
const openTrades = new Map<string, OpenTrade>();
// Mint yang pernah dibeli: jangan beli ulang — sinyal hanya berlaku untuk
// 10 trade pertama, dan ini membantu menyebar ke 20+ mint berbeda.
const tradedMints = new Set<string>();

// Harga SOL per token dari cadangan virtual (rasio quote/token; presisi Number cukup
// untuk perubahan level bps karena kedua cadangan jauh di bawah 2^53 dalam rasio).
function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const q = Number(curve.virtual_quote_reserves);
  const t = Number(curve.virtual_token_reserves);
  if (t <= 0 || q <= 0) return 0;
  return q / t;
}

// Perbarui jejak per mint dari batch ini: hitung trade + statistik 10 trade pertama.
function updateTracks(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      let tr = tracks.get(e.mint);
      if (tr === undefined) {
        tr = { firstSeq: state.seq, trades: 0, price: 0, creator: '', buysFirst10: 0, creatorBuyLamports: 0n, evaluated: false };
        tracks.set(e.mint, tr);
      }
      tr.creator = e.creator;
    } else if (e.event === 'TradeEvent') {
      let tr = tracks.get(e.mint);
      if (tr === undefined) {
        tr = { firstSeq: state.seq, trades: 0, price: 0, creator: '', buysFirst10: 0, creatorBuyLamports: 0n, evaluated: false };
        tracks.set(e.mint, tr);
      }
      tr.trades += 1;
      if (tr.trades <= FIRST_TRADES) {
        if (e.is_buy) {
          tr.buysFirst10 += 1;
          if (tr.creator !== '' && e.user === tr.creator) {
            tr.creatorBuyLamports += BigInt(e.sol_amount);
          }
        }
      }
      const curve = state.curves.get(e.mint);
      if (curve !== undefined && !curve.complete) {
        const p = priceOf(curve);
        if (p > 0) tr.price = p;
      }
    }
  }
  // Bersihkan jejak posisi yang sudah tidak dipegang.
  for (const mint of [...openTrades.keys()]) {
    if (!state.positions.has(mint)) openTrades.delete(mint);
  }
}

// Keputusan order untuk satu batch: keluar dulu (bebaskan slot), lalu masuk.
function decideOrders(state: BotState, _batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];

  // --- 1. KELUAR: periksa tiap posisi terbuka terhadap TP / SL / batas pegang.
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue; // complete ditutup harness sendiri
    const price = priceOf(curve);
    if (price <= 0) continue;
    const tokens = pos.token_amount;
    if (tokens <= 0n) continue;
    const costPrice = Number(pos.cost_lamports) / Number(tokens); // harga pokok incl. fee beli
    if (costPrice <= 0) continue;
    let trade = openTrades.get(mint);
    if (trade === undefined) {
      trade = { entrySeq: state.seq, takeProfitBps: TAKE_PROFIT_BPS };
      openTrades.set(mint, trade);
    }
    const retBps = Math.round(((price - costPrice) / costPrice) * 10000);
    const heldBatches = state.seq - trade.entrySeq;
    let exit = false;
    if (retBps >= trade.takeProfitBps) exit = true; // take-profit
    else if (retBps <= -STOP_LOSS_BPS) exit = true; // stop-loss
    else if (heldBatches >= MAX_HOLD_BATCHES) exit = true; // batas waktu pegang
    if (exit) {
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }

  // --- 2. MASUK: koin yang 10 trade pertamanya SEMUA beli + real reserve >= 1 SOL.
  // Dinilai tepat saat trade ke-10 tiba (satu kali per mint, deterministik).
  // Koin dengan dukungan creator (creator beli >= 0,3 SOL di 10 trade pertama)
  // diberi TP lebih longgar (+20% vs +15%).
  const exiting = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
  const openNow = state.committedPositionCount() - exiting.size;
  const freeSlots = Math.max(0, state.hello.caps.max_open_positions - openNow);
  if (freeSlots > 0) {
    const candidates: { mint: string; creatorBacked: boolean }[] = [];
    for (const [mint, tr] of tracks) {
      // Nilai sekali, di batch pertama saat trade sudah >= 10: statistik 10 trade
      // pertama sudah lengkap (diperbarui hanya selagi trades <= 10), walau trade
      // ke-10 tiba di tengah batch yang sama dengan trade ke-11/12.
      if (tr.trades < FIRST_TRADES || tr.evaluated) continue;
      tr.evaluated = true; // nilai sekali, tepat di trade ke-10
      if (tr.buysFirst10 !== FIRST_TRADES) continue; // harus 10/10 beli
      if (tradedMints.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      if (exiting.has(mint)) continue;
      if ([...state.pending.values()].some((p) => p.order.side === 'buy' && p.order.mint === mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Real SOL reserve sudah >= 1 SOL: cap beli >= 0,01 SOL.
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      if (state.maxBuyLamports(mint) < MIN_BUY_LAMPORTS) continue;
      candidates.push({ mint, creatorBacked: tr.creatorBuyLamports >= CREATOR_MIN_BUY_LAMPORTS });
    }
    // Urutan deterministik: koin dukungan creator dulu, lalu nama mint.
    candidates.sort((a, b) => Number(b.creatorBacked) - Number(a.creatorBacked) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    const txFee = state.txFeeLamports();
    let buys = 0;
    for (const c of candidates) {
      if (buys >= Math.min(MAX_BUYS_PER_BATCH, freeSlots)) break;
      const cap = state.maxBuyLamports(c.mint);
      // Ukuran bertingkat: dukungan creator -> sampai 0,05 SOL; biasa -> 0,011 SOL.
      const target = c.creatorBacked ? POSITION_SIZE_LAMPORTS : BASE_SIZE_LAMPORTS;
      let size = target < cap ? target : cap;
      const free = state.freeCashLamports();
      const afford = free - txFee;
      if (afford < MIN_BUY_LAMPORTS) break; // kas bebas habis
      if (size > afford) size = afford;
      if (size < MIN_BUY_LAMPORTS) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
      tradedMints.add(c.mint);
      openTrades.set(c.mint, {
        entrySeq: state.seq,
        takeProfitBps: c.creatorBacked ? TAKE_PROFIT_CREATOR_BPS : TAKE_PROFIT_BPS,
      });
      buys++;
    }
  }

  return orders;
}

// ------------------------------------------------------------------ wiring harness
await runBot({
  onBatch(state, batch) {
    updateTracks(state, batch);
    return decideOrders(state, batch);
  },
});
