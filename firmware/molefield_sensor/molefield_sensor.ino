/* ───────────────────────────────────────────────────────────────────────────
   MOLEFIELD Sensor Box Firmware — ESP32 + 2 × RCWL-1601
   ENGG3000 SPINE · Full-Body Whack-a-Mole

   Each box fires its ultrasonic sensors in a time slot synchronized by the PC,
   then sends one UDP datagram per cycle:

       {"box":0,"t":184213,"ranges":[1420,1655],"batt":5210}

   Ranges are in millimetres to nearest surface (null where no echo returned).
   Telemetry fields are extensible without breaking bridge compatibility.

   WHY PING SLOTS MATTER:
   Four ultrasonic sensors aimed at the same person will cross-talk if fired
   simultaneously. A receiver catching a neighbour's acoustic burst reports
   a falsely short range, corrupting the position solution. Time-slotting
   guarantees only one sensor emits ultrasound at a given moment:

       beacon ──▶ │ box0 s0 │ box0 s1 │ box1 s0 │ box1 s1 │ ...idle... │
                   0 ms      16 ms     32 ms     48 ms     64 ms = next beacon

   WIRING (per sensor, 3.3V safe):
       VCC  → 3V3 (or VIN depending on board regulator)
       GND  → GND
       TRIG → see TRIG_PINS below
       ECHO → see ECHO_PINS below

   CONFIGURATION:
   Set BOX_ID to 0 on the first box and 1 on the second before flashing.
   ─────────────────────────────────────────────────────────────────────────── */

#include <WiFi.h>
#include <WiFiUdp.h>

/* ── Per-Box Configuration ──────────────────────────────────────────────── */
#define BOX_ID            0            // 0 or 1 — MUST differ between physical boxes

// Networking Mode:
// true  = Standalone AP mode (Box 0 creates Wi-Fi "Dylan&CO.", Box 1 & PC join it)
// false = External router mode (Both boxes connect to an existing Wi-Fi router)
#define STANDALONE_AP     true

const char* WIFI_SSID   = "Molefield";
const char* WIFI_PASS   = "molefield123";

const uint16_t UDP_TX_PORT   = 4210;   // Outbound telemetry datagrams to PC bridge
const uint16_t UDP_SYNC_PORT = 4211;   // Inbound slot sync beacon from PC bridge
const bool     USE_BROADCAST = true;   // false -> send unicast to BRIDGE_IP
IPAddress      BRIDGE_IP(192, 168, 4, 2);

/* ── Hardware Pinout (HC-SR04 / RCWL-1601) ──────────────────────────────── */
const uint8_t  N_SENSORS = 2;
const uint8_t  TRIG_PINS[N_SENSORS] = { 32, 26 };  // Sensor 1: GPIO 32, Sensor 2: GPIO 26
const uint8_t  ECHO_PINS[N_SENSORS] = { 35, 27 };  // Sensor 1: GPIO 35, Sensor 2: GPIO 27

/* ── Timing & Acoustic Constants ────────────────────────────────────────── */
const uint16_t SLOT_MS         = 16;    // Time window allocated per sensor (ms)
const uint32_t ECHO_TIMEOUT_US = 14000; // ~2.4 m maximum acoustic flight time
const float    SPEED_OF_SOUND  = 0.343; // mm per microsecond at ~20 °C

/* ── Battery Voltage Sensing ────────────────────────────────────────────── */
const uint8_t  VBAT_PIN     = 34;       // ADC1 pin with resistor divider from battery +
const float    VBAT_DIVIDER = 2.0;      // Equal resistor divider ratio
const bool     VBAT_ENABLED = true;

WiFiUDP udpTx, udpSync;
char packet[256];
uint16_t lastSeq = 0xFFFF;
uint32_t lastRange[N_SENSORS] = { 0 };

/* ── Ultrasonic Ping Measurement ────────────────────────────────────────── */
long pingSensor(uint8_t i) {
  digitalWrite(TRIG_PINS[i], LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PINS[i], HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PINS[i], LOW);

  uint32_t us = pulseIn(ECHO_PINS[i], HIGH, ECHO_TIMEOUT_US);
  if (us == 0) return -1; // No acoustic return within maximum window

  long mm = (long)(us * SPEED_OF_SOUND / 2.0f);
  if (mm < 40 || mm > 4000) return -1; // Outside honest sensor operating window

  /* Spike Guard: A single reading jumping > 500 mm is typically cross-talk
     or acoustic multipath bounce. Reject once, then accept if confirmed. */
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

/* ── Slotted Measurement & Transmission Cycle ───────────────────────────── */
void runCycle() {
  const uint32_t slotStart = millis();
  const uint16_t myOffset  = BOX_ID * N_SENSORS * SLOT_MS;

  long mm[N_SENSORS];
  for (uint8_t i = 0; i < N_SENSORS; i++) {
    const uint32_t due = slotStart + myOffset + (uint32_t)i * SLOT_MS;
    while ((int32_t)(millis() - due) < 0) {
      // Hold until allocated time slot
    }
    mm[i] = pingSensor(i);
  }

  // Format JSON payload
  int n = snprintf(packet, sizeof(packet), "{\"box\":%d,\"t\":%lu,\"ranges\":[",
                   BOX_ID, (unsigned long)millis());
  for (uint8_t i = 0; i < N_SENSORS; i++) {
    if (mm[i] < 0) {
      n += snprintf(packet + n, sizeof(packet) - n, "%snull", i ? "," : "");
    } else {
      n += snprintf(packet + n, sizeof(packet) - n, "%s%ld", i ? "," : "", mm[i]);
    }
  }
  snprintf(packet + n, sizeof(packet) - n, "],\"batt\":%u}", readBatteryMv());

  // Transmit over UDP
  IPAddress dest = USE_BROADCAST ? IPAddress(255, 255, 255, 255) : BRIDGE_IP;
  udpTx.beginPacket(dest, UDP_TX_PORT);
  udpTx.print(packet);
  udpTx.endPacket();

  // Also broadcast to SoftAP subnet in standalone mode
#if STANDALONE_AP
  udpTx.beginPacket(IPAddress(192, 168, 4, 255), UDP_TX_PORT);
  udpTx.print(packet);
  udpTx.endPacket();
#endif

  // Periodic Serial debug output matching electrical team's format
  static unsigned long lastSerialPrint = 0;
  if (millis() - lastSerialPrint >= 100) {
    lastSerialPrint = millis();
    long dist1_cm = (mm[0] > 0) ? mm[0] / 10 : -1;
    long dist2_cm = (mm[1] > 0) ? mm[1] / 10 : -1;
    
    Serial.print("distance1: ");
    Serial.print(dist1_cm);
    Serial.print("\t");
    Serial.print("distance2: ");
    Serial.print(dist2_cm);
    Serial.println(" cm");
  }
}

/* ── Setup & Main Loop ──────────────────────────────────────────────────── */
void setup() {
  Serial.begin(115200);

  for (uint8_t i = 0; i < N_SENSORS; i++) {
    pinMode(TRIG_PINS[i], OUTPUT);
    pinMode(ECHO_PINS[i], INPUT);
    digitalWrite(TRIG_PINS[i], LOW);
  }
  if (VBAT_ENABLED) {
    analogSetPinAttenuation(VBAT_PIN, ADC_11db);
  }

#if STANDALONE_AP
  #if BOX_ID == 0
  // ── Box 0: Broadcasts the standalone Wi-Fi Access Point ──
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(WIFI_SSID, WIFI_PASS);
  Serial.printf("\n========================================\n");
  Serial.printf("Sensor Box 0 created Wi-Fi AP '%s'\n", WIFI_SSID);
  Serial.printf("AP IP address: %s\n", WiFi.softAPIP().toString().c_str());
  Serial.printf("Connect your Laptop to '%s' (Pass: '%s')\n", WIFI_SSID, WIFI_PASS);
  Serial.printf("========================================\n");
  #else
  // ── Box 1: Connects to Box 0's Wi-Fi Access Point ──
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("\nSensor Box %d connecting to AP '%s'...", BOX_ID, WIFI_SSID);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
    attempts++;
    if (attempts % 30 == 0) {
      Serial.printf("\nStill trying to connect to '%s'...\n", WIFI_SSID);
    }
  }
  Serial.printf("\n========================================\n");
  Serial.printf("Sensor Box %d connected to AP!\n", BOX_ID);
  Serial.printf("Assigned IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("========================================\n");
  #endif
#else
  // ── External Router Mode: Both boxes join existing network ──
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);               // Modem sleep between packet bursts
  WiFi.setTxPower(WIFI_POWER_11dBm); // Sufficient across a room, conserves battery
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.printf("Sensor box %d connecting to %s", BOX_ID, WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.printf("\nSensor box %d ready at IP: %s\n", BOX_ID, WiFi.localIP().toString().c_str());
#endif

  udpTx.begin(0);
  udpSync.begin(UDP_SYNC_PORT);
}

unsigned long lastCycleTime = 0;
const unsigned long FALLBACK_CYCLE_MS = 150; // Fallback timer if PC sync beacon is lost

void loop() {
  // Check for PC synchronization beacon
  int sz = udpSync.parsePacket();
  if (sz > 0) {
    char buf[64];
    int len = udpSync.read(buf, sizeof(buf) - 1);
    if (len > 0) {
      buf[len] = 0;
      char* p = strstr(buf, "\"sync\":");
      if (p) {
        uint16_t seq = (uint16_t)atoi(p + 7);
        if (seq != lastSeq) {
          lastSeq = seq;
          lastCycleTime = millis();
          runCycle();
          return;
        }
      }
    }
  }

  // Fallback: If no sync beacon arrives from PC within 65ms, ping autonomously
  if (millis() - lastCycleTime >= FALLBACK_CYCLE_MS) {
    lastCycleTime = millis();
    runCycle();
  }

  delay(1);
}
