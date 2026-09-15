#include <WiFi.h>
#include <WiFiUdp.h>

#define TRIG_PIN1 32
#define ECHO_PIN1 35
#define TRIG_PIN2 26
#define ECHO_PIN2 27
#define MAX_DIST_CM 800

#define BOX_ID 1 // Set to 0 for the AP (Box 0), or 1 for the station (Box 1)

const char* WIFI_SSID   = "Molefield";
const char* WIFI_PASS   = "molefield123";

float tempC = 23.0;  // fallback temperature

WiFiUDP udpTx;
WiFiUDP udpSync;
const char* host = "255.255.255.255"; // Broadcast to reach the bridge
const uint16_t port = 5000;           // Port matching bridge/config.py DEFAULTS["udp"]
const uint16_t sync_port = 4211;      // PC broadcasts sync beacon here

uint16_t lastSeq = 0xFFFF;
unsigned long lastCycleTime = 0;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN1, OUTPUT);
  pinMode(TRIG_PIN2, OUTPUT);
  pinMode(ECHO_PIN1, INPUT);
  pinMode(ECHO_PIN2, INPUT);
  digitalWrite(TRIG_PIN1, LOW);
  digitalWrite(TRIG_PIN2, LOW);

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
  udpSync.begin(sync_port); // Start listening for the PC's sync beacon!
}

float pingCm(int trigPin, int echoPin, float temp) {
  float sos = 331.4 + 0.606 * temp;  // speed of sound m/s
  long timeout_us = (long)((MAX_DIST_CM * 2.0 / 100.0 / sos) * 1e6) + 1000;

  digitalWrite(trigPin, LOW);
  delayMicroseconds(4);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long dur = pulseIn(echoPin, HIGH, timeout_us);
  if (dur == 0) return -1;

  return (dur * sos) / (2.0 * 10000.0);
}

void runCycle() {
  // Wait for our specific 16ms time slot based on BOX_ID to prevent cross-talk!
  const uint32_t slotStart = millis();
  const uint16_t myOffset  = BOX_ID * 2 * 16; 
  
  // Measure Sensor 1 in its 16ms slot
  while ((int32_t)(millis() - (slotStart + myOffset)) < 0) { }
  float dist1 = pingCm(TRIG_PIN1, ECHO_PIN1, tempC);

  // Measure Sensor 2 in its 16ms slot
  while ((int32_t)(millis() - (slotStart + myOffset + 16)) < 0) { }
  float dist2 = pingCm(TRIG_PIN2, ECHO_PIN2, tempC);

  // Send JSON payload formatted perfectly for the game!
  char payload[128];
  int n = snprintf(payload, sizeof(payload), "{\"box\":%d,\"t\":%lu,\"ranges\":[", BOX_ID, (unsigned long)millis());
  
  if (dist1 > 0) n += snprintf(payload + n, sizeof(payload) - n, "%ld", (long)(dist1 * 10.0));
  else n += snprintf(payload + n, sizeof(payload) - n, "null");
  
  n += snprintf(payload + n, sizeof(payload) - n, ",");
  
  if (dist2 > 0) n += snprintf(payload + n, sizeof(payload) - n, "%ld", (long)(dist2 * 10.0));
  else n += snprintf(payload + n, sizeof(payload) - n, "null");
  
  snprintf(payload + n, sizeof(payload) - n, "]}");

  udpTx.beginPacket(host, port);
  udpTx.print(payload);
  udpTx.endPacket();

  #if BOX_ID == 0
  udpTx.beginPacket(IPAddress(192, 168, 4, 255), port);
  udpTx.print(payload);
  udpTx.endPacket();
  #endif
  
  // Minimal Serial debug so it doesn't block the strict timing
  static unsigned long lastSerialPrint = 0;
  if (millis() - lastSerialPrint >= 100) {
    lastSerialPrint = millis();
    Serial.printf("S1: %.1f cm | S2: %.1f cm\n", dist1, dist2);
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
          runCycle(); // Run the ping sequence synced with the PC!
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
