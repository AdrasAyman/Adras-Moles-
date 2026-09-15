#include <WiFi.h>

#define BOX_ID 0 // Set to 0 for the AP (Box 0), or 1 for the station (Box 1)

const char* WIFI_SSID   = "Molefield";
const char* WIFI_PASS   = "molefield123";

void setup() {
  Serial.begin(115200);

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
}

void loop() {
  // Put your main code here, to run repeatedly:
}
