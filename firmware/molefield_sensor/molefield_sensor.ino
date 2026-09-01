#include <WiFi.h>
#include <WiFiUdp.h>

// ================================================================
// CONFIGURATION
// ================================================================
#define BOX_ID 0 // 0 for Box 0, 1 for Box 1 (MUST differ between physical boxes)

// Set true to create a standalone Wi-Fi AP on Box 0; false to join a router
#define STANDALONE_AP true

const char* WIFI_SSID = "Molefield";
const char* WIFI_PASS = "molefield123";

const uint16_t UDP_TX_PORT   = 4210; // Outbound telemetry port
const uint16_t UDP_SYNC_PORT = 4211; // Inbound PC sync beacon port

const IPAddress BROADCAST_IP(255, 255, 255, 255);

// ================================================================
// HARDWARE PIN ASSIGNMENTS (HC-SR04 / RCWL-1601)
// ================================================================
#define TRIG_PIN_1 33
#define ECHO_PIN_1 32

#define TRIG_PIN_2 27
#define ECHO_PIN_2 26

// ================================================================
// TIMING & GLOBAL OBJECTS
// ================================================================
WiFiUDP udpTx, udpSync;

const int SENSOR_SLOT_MS = 16;
const int N_SENSORS      = 2;
const int MY_OFFSET_MS   = BOX_ID * N_SENSORS * SENSOR_SLOT_MS;

uint16_t lastSeq = 0xFFFF;
unsigned long lastCycleStart = 0;
const unsigned long FALLBACK_CYCLE_MS = 150; // Fallback timer if PC sync beacon drops

// ================================================================
// ULTRASONIC READING FUNCTION (UNCHANGED)
// ================================================================
float readUltrasonicDistance(int trigPin, int echoPin) {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin, LOW);
    
    long duration_us = pulseIn(echoPin, HIGH, 30000);
    
    if (duration_us == 0) {
        return -1.0;
    }
    
    return duration_us * 0.01715; // Returns distance in cm
}

// ================================================================
// MEASUREMENT & TRANSMISSION CYCLE
// ================================================================
void runCycle() {
    const uint32_t slotStart = millis();

    // 1. Wait until this box's allocated time slot starts
    while ((int32_t)(millis() - (slotStart + MY_OFFSET_MS)) < 0) {
        delayMicroseconds(100);
    }

    // 2. Read physical sensors sequentially within time slots
    float dist1_cm = readUltrasonicDistance(TRIG_PIN_1, ECHO_PIN_1);
    
    while ((int32_t)(millis() - (slotStart + MY_OFFSET_MS + SENSOR_SLOT_MS)) < 0) {
        delayMicroseconds(100);
    }
    float dist2_cm = readUltrasonicDistance(TRIG_PIN_2, ECHO_PIN_2);

    // Convert cm float to integer mm for downstream bridge (null / -1 handled)
    long mm1 = (dist1_cm > 0) ? (long)(dist1_cm * 10.0f) : -1;
    long mm2 = (dist2_cm > 0) ? (long)(dist2_cm * 10.0f) : -1;

    // 3. Format exact JSON payload expected by host bridge
    char packet[128];
    int n = snprintf(packet, sizeof(packet), "{\"box\":%d,\"t\":%lu,\"ranges\":[", BOX_ID, (unsigned long)millis());
    
    if (mm1 < 0) n += snprintf(packet + n, sizeof(packet) - n, "null,");
    else        n += snprintf(packet + n, sizeof(packet) - n, "%ld,", mm1);

    if (mm2 < 0) n += snprintf(packet + n, sizeof(packet) - n, "null],\"batt\":0}");
    else        n += snprintf(packet + n, sizeof(packet) - n, "%ld],\"batt\":0}");

    // 4. Transmit packet over UDP
    udpTx.beginPacket(BROADCAST_IP, UDP_TX_PORT);
    udpTx.print(packet);
    udpTx.endPacket();

#if STANDALONE_AP
    udpTx.beginPacket(IPAddress(192, 168, 4, 255), UDP_TX_PORT);
    udpTx.print(packet);
    udpTx.endPacket();
#endif
}

// ================================================================
// SETUP
// ================================================================
void setup() {
    Serial.begin(115200);

    pinMode(TRIG_PIN_1, OUTPUT);
    pinMode(ECHO_PIN_1, INPUT);
    pinMode(TRIG_PIN_2, OUTPUT);
    pinMode(ECHO_PIN_2, INPUT);

#if STANDALONE_AP
  #if BOX_ID == 0
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(WIFI_SSID, WIFI_PASS);
    Serial.printf("\n[Wi-Fi] Box 0 AP Created: %s\n", WIFI_SSID);
  #else
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("\n[Box %d] Connecting to AP %s...", BOX_ID, WIFI_SSID);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\n[Wi-Fi] Connected to AP!");
  #endif
#else
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("\n[Box %d] Connecting to %s...", BOX_ID, WIFI_SSID);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\n[Wi-Fi] Connected to Router!");
#endif

    udpTx.begin(0);
    udpSync.begin(UDP_SYNC_PORT);
    Serial.printf("[UDP] Telemetry TX Port: %d | Sync RX Port: %d\n", UDP_TX_PORT, UDP_SYNC_PORT);
}

// ================================================================
// MAIN LOOP
// ================================================================
void loop() {
    // 1. Listen for PC Synchronization Beacon
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
                    lastCycleStart = millis();
                    runCycle();
                    return;
                }
            }
        }
    }

    // 2. Fallback: Ping autonomously if no PC sync packet arrives in 150 ms
    if (millis() - lastCycleStart >= FALLBACK_CYCLE_MS) {
        lastCycleStart = millis();
        runCycle();
    }

    delay(1);
}