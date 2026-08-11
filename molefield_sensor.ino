/* ───────────────────────────────────────────────────────────────────────────
   MOLEFIELD sensor box — ESP32 + 2 × RCWL-1601
   ENGG3000 SPINE · full-body Whack-a-Mole

   Each box fires its ultrasonic sensors in a time slot handed out by the PC,
   then sends one UDP datagram per cycle:

       {"box":0,"t":184213,"ranges":[1420,1655],"batt":5210}

   ranges are millimetres to the nearest surface; null means no echo.
   The bridge ignores fields it doesn't know, so add your own telemetry freely.

   WHY THE SLOTS MATTER
   Four ultrasonic sensors pointed at the same person will hear each other.
   A sensor that receives its neighbour's burst reports a short, confident,
   completely wrong range — and a wrong range poisons the position fit far
   worse than a missing one does. So nobody pings whenever they feel like it:
   the PC broadcasts a beacon, and every box waits for its own slot.

       beacon ──▶ │ box0 s0 │ box0 s1 │ box1 s0 │ box1 s1 │ ...idle... │
                   0 ms      16 ms     32 ms     48 ms     64 ms = next beacon

   WIRING (per sensor, no level shifters needed — the RCWL-1601 is 3.3 V)
       VCC  → 3V3 (or VIN if you feed it from the pack; check your board)
       GND  → GND
       TRIG → see TRIG_PINS below
       ECHO → see ECHO_PINS below

   Set BOX_ID to 0 on the first box and 1 on the second before flashing.
   ─────────────────────────────────────────────────────────────────────────── */

#include <WiFi.h>
#include <WiFiUdp.h>

/* ── configure per box ──────────────────────────────────────────────────── */
#define BOX_ID            0            // 0 or 1 — MUST differ between boxes

const char* WIFI_SSID   = "MOLEFIELD";
const char* WIFI_PASS   = "whackamole";

const uint16_t UDP_TX_PORT   = 4210;   // ranges out to the bridge
const uint16_t UDP_SYNC_PORT = 4211;   // slot beacon in from the bridge
const bool     USE_BROADCAST = true;   // false → send only to BRIDGE_IP
IPAddress      BRIDGE_IP(192, 168, 4, 2);

/* ── sensors in this box ────────────────────────────────────────────────── */
const uint8_t  N_SENSORS = 2;
const uint8_t  TRIG_PINS[N_SENSORS] = { 25, 27 };
const uint8_t  ECHO_PINS[N_SENSORS] = { 26, 14 };

/* ── timing ─────────────────────────────────────────────────────────────── */
const uint16_t SLOT_MS         = 16;    // one sensor's turn
const uint32_t ECHO_TIMEOUT_US = 14000; // ≈2.4 m — the far corner of the area
const float    SPEED_OF_SOUND  = 0.343; // mm per µs at ~20 °C

/* ── battery sense (optional but you need this data for the benchmark) ──── */
const uint8_t  VBAT_PIN     = 34;       // ADC1 — divider from pack +
const float    VBAT_DIVIDER = 2.0;      // two equal resistors
const bool     VBAT_ENABLED = true;

WiFiUDP udpTx, udpSync;
char packet[256];
uint16_t lastSeq = 0xFFFF;
uint32_t lastRange[N_SENSORS] = { 0 };

/* ── one ping, one range ────────────────────────────────────────────────── */
long pingSensor(uint8_t i) {
  digitalWrite(TRIG_PINS[i], LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PINS[i], HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PINS[i], LOW);

  uint32_t us = pulseIn(ECHO_PINS[i], HIGH, ECHO_TIMEOUT_US);
  if (us == 0) return -1;                       // no echo inside the window

  long mm = (long)(us * SPEED_OF_SOUND / 2.0f);
  if (mm < 40 || mm > 4000) return -1;          // outside the sensor's honest range

  /* Spike guard: a single reading that leaps more than 500 mm is far more
     likely to be cross-talk or a floor bounce than a person teleporting.
     Reject it once, then believe it if it repeats. */
  if (lastRange[i] != 0 && labs(mm - (long)lastRange[i]) > 500) {
    lastRange[i] = mm;
    return -1;
  }
  lastRange[i] = mm;
  return mm;
}

uint16_t readBatteryMv() {
  if (!VBAT_ENABLED) return 0;
  uint32_t acc = 0;
  for (uint8_t k = 0; k < 8; k++) acc += analogReadMilliVolts(VBAT_PIN);
  return (uint16_t)((acc / 8) * VBAT_DIVIDER);
}

/* ── wait for our slot, fire, report ────────────────────────────────────── */
void runCycle() {
  const uint32_t slotStart = millis();
  const uint16_t myOffset  = BOX_ID * N_SENSORS * SLOT_MS;

  long mm[N_SENSORS];
  for (uint8_t i = 0; i < N_SENSORS; i++) {
    const uint32_t due = slotStart + myOffset + (uint32_t)i * SLOT_MS;
    while ((int32_t)(millis() - due) < 0) { /* hold for our turn */ }
    mm[i] = pingSensor(i);
  }

  int n = snprintf(packet, sizeof(packet), "{\"box\":%d,\"t\":%lu,\"ranges\":[",
                   BOX_ID, (unsigned long)millis());
  for (uint8_t i = 0; i < N_SENSORS; i++) {
    if (mm[i] < 0) n += snprintf(packet + n, sizeof(packet) - n, "%snull",
                                 i ? "," : "");
    else           n += snprintf(packet + n, sizeof(packet) - n, "%s%ld",
                                 i ? "," : "", mm[i]);
  }
  snprintf(packet + n, sizeof(packet) - n, "],\"batt\":%u}", readBatteryMv());

  IPAddress dest = USE_BROADCAST ? IPAddress(255, 255, 255, 255) : BRIDGE_IP;
  udpTx.beginPacket(dest, UDP_TX_PORT);
  udpTx.print(packet);
  udpTx.endPacket();
}

/* ── setup / loop ───────────────────────────────────────────────────────── */
void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < N_SENSORS; i++) {
    pinMode(TRIG_PINS[i], OUTPUT);
    pinMode(ECHO_PINS[i], INPUT);
    digitalWrite(TRIG_PINS[i], LOW);
  }
  if (VBAT_ENABLED) analogSetPinAttenuation(VBAT_PIN, ADC_11db);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);                  // modem sleep between packets
  WiFi.setTxPower(WIFI_POWER_11dBm);    // plenty across a 2 m room, saves mA
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("box %d joining %s", BOX_ID, WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print("."); }
  Serial.printf("\nbox %d up on %s\n", BOX_ID, WiFi.localIP().toString().c_str());

  udpTx.begin(0);
  udpSync.begin(UDP_SYNC_PORT);
}

void loop() {
  int sz = udpSync.parsePacket();
  if (sz <= 0) { delay(1); return; }

  char buf[64];
  int len = udpSync.read(buf, sizeof(buf) - 1);
  if (len <= 0) return;
  buf[len] = 0;

  /* Beacon is {"sync":1234}. Skipped sequence numbers mean dropped beacons —
     worth counting during testing, it tells you how healthy the link is. */
  char* p = strstr(buf, "\"sync\":");
  if (!p) return;
  uint16_t seq = (uint16_t)atoi(p + 7);
  if (seq == lastSeq) return;
  lastSeq = seq;

  runCycle();
}
