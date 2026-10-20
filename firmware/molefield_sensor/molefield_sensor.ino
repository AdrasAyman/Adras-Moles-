#include <WiFi.h>
#include <WiFiUdp.h>

#define TRIG_PIN1 32
#define ECHO_PIN1 35
#define TRIG_PIN2 26
#define TRIG_PIN3 23
#define ECHO_PIN2 27
#define ECHO_PIN3 22
#define MAX_DIST_CM 800

#define BOX_ID 1  // Set to 0 for the AP (Box 0), or 1 for the station (Box 1)

const char* WIFI_SSID = "Molefield";
const char* WIFI_PASS = "molefield123";

float tempC = 23.0;  // fallback temperature

WiFiUDP udpTx;
WiFiUDP udpSync;
// Broadcast on the Molefield subnet. In AP_STA mode box 0 can send a
// 255.255.255.255 broadcast out of its unconnected STA side instead of the AP,
// so both boxes use the subnet broadcast, which goes out on the Molefield network.
IPAddress host(192, 168, 4, 255);
const uint16_t port = 5000;            // Port matching bridge/config.py DEFAULTS["udp"]
const uint16_t sync_port = 4211;       // PC broadcasts sync beacon here

uint16_t lastSeq = 0xFFFF;
unsigned long lastCycleTime = 0;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN1, OUTPUT);
  pinMode(TRIG_PIN2, OUTPUT);
  pinMode(TRIG_PIN3, OUTPUT);
  pinMode(ECHO_PIN1, INPUT);
  pinMode(ECHO_PIN2, INPUT);
  pinMode(ECHO_PIN3, INPUT);
  digitalWrite(TRIG_PIN1, LOW);
  digitalWrite(TRIG_PIN2, LOW);
  digitalWrite(TRIG_PIN3, LOW);

#if BOX_ID == 0
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(WIFI_SSID, WIFI_PASS);
  Serial.printf("\n========================================\n");
  Serial.printf("Sensor Box 0 created Wi-Fi AP '%s'\n", WIFI_SSID);
#else
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("\nSensor Box %d connecting to AP '%s'...", BOX_ID, WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.printf("\nSensor Box %d connected to AP!\n", BOX_ID);
#endif

  udpTx.begin(port);
  udpSync.begin(sync_port);  // Start listening for the PC's sync beacon!
}

const int TRIG_PINS[3] = { TRIG_PIN1, TRIG_PIN2, TRIG_PIN3 };
const int ECHO_PINS[3] = { ECHO_PIN1, ECHO_PIN2, ECHO_PIN3 };

// Fires all three sensors at once and times their echo pulses side by side
// (pulseIn can only watch one pin at a time). MAX_DIST_CM where no echo.
void pingAllCm(float out[3], float temp) {
  float sos = 331.4 + 0.606 * temp;  // speed of sound m/s
  long timeout_us = (long)((MAX_DIST_CM * 2.0 / 100.0 / sos) * 1e6) + 1000;

  for (int i = 0; i < 3; i++) digitalWrite(TRIG_PINS[i], LOW);
  delayMicroseconds(4);
  for (int i = 0; i < 3; i++) digitalWrite(TRIG_PINS[i], HIGH);
  delayMicroseconds(10);
  for (int i = 0; i < 3; i++) digitalWrite(TRIG_PINS[i], LOW);

  uint32_t rise[3] = { 0, 0, 0 }, dur[3] = { 0, 0, 0 };
  uint8_t rising = 0, done = 0;  // bit i set = sensor i's pulse started / ended
  const uint32_t start = micros();
  while (done != 0b111 && micros() - start < (uint32_t)timeout_us) {
    for (int i = 0; i < 3; i++) {
      if (done & (1 << i)) continue;
      bool high = digitalRead(ECHO_PINS[i]);
      if (high && !(rising & (1 << i))) {
        rise[i] = micros();
        rising |= 1 << i;
      } else if (!high && (rising & (1 << i))) {
        dur[i] = micros() - rise[i];
        done |= 1 << i;
      }
    }
  }

  for (int i = 0; i < 3; i++) {
    out[i] = (done & (1 << i)) ? (dur[i] * sos) / (2.0 * 10000.0) : MAX_DIST_CM;
  }
}

void runCycle() {
  // Each box gets one 48 ms slot (the echo timeout is ~47.5 ms), so the two
  // boxes never ping at the same time. Box 0 at 0 ms, box 1 at 48 ms.
  const uint32_t slotStart = millis();
  const uint16_t myOffset = BOX_ID * 48;

  while ((int32_t)(millis() - (slotStart + myOffset)) < 0) {}
  float dist[3];
  pingAllCm(dist, tempC);

  // Nearest of the three sensors (MAX_DIST_CM when none of them got an echo)
  float nearest = min(dist[0], min(dist[1], dist[2]));

  // Send only box id and value, e.g. "1: 142.5" (cm)
  char payload[32];
  snprintf(payload, sizeof(payload), "%d: %.1f", BOX_ID, nearest);

  // One send per cycle, so the bridge doesn't count box 0 twice
  udpTx.beginPacket(host, port);
  udpTx.print(payload);
  udpTx.endPacket();

  // Minimal Serial debug so it doesn't block the strict timing
  static unsigned long lastSerialPrint = 0;
  if (millis() - lastSerialPrint >= 100) {
    lastSerialPrint = millis();
    Serial.println(payload);
  }
}

void loop() {
  // 1. Check for PC synchronization beacon (broadcast on port 4211)
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
          runCycle();  // Run the ping sequence synced with the PC!
          return;
        }
      }
    }
  }

  // 2. Fallback: If no sync beacon arrives from PC within 150ms, ping autonomously anyway
  if (millis() - lastCycleTime >= 150) {
    lastCycleTime = millis();
    runCycle();
  }

  delay(1);
}
