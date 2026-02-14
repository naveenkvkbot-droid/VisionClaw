import CoreLocation
import BackgroundTasks
import Foundation

/// BackgroundLocationManager handles location updates even when the app is closed.
/// Uses significant location changes (cell tower/WiFi) which is battery-efficient.
class BackgroundLocationManager: NSObject, ObservableObject {
    static let shared = BackgroundLocationManager()
    
    private let locationManager = CLLocationManager()
    private let session: URLSession
    
    @Published var currentLocation: CLLocation?
    @Published var authorizationStatus: CLAuthorizationStatus = .notDetermined
    
    // OpenClaw configuration
    private var openClawHost: String {
        GeminiConfig.openClawHost
    }
    
    private var openClawPort: Int {
        GeminiConfig.openClawPort
    }
    
    private var openClawToken: String {
        GeminiConfig.openClawGatewayToken
    }
    
    private var isOpenClawConfigured: Bool {
        GeminiConfig.isOpenClawConfigured
    }
    
    private let backgroundTaskIdentifier = "com.visionclaw.location"
    
    override init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
        
        super.init()
        
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        locationManager.distanceFilter = 1000 // Update after moving 1km
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
        
        authorizationStatus = locationManager.authorizationStatus
    }
    
    /// Request "Always" location permission for background updates
    func requestAlwaysPermission() {
        locationManager.requestAlwaysAuthorization()
    }
    
    /// Start monitoring significant location changes (works in background)
    func startBackgroundUpdates() {
        locationManager.startMonitoringSignificantLocationChanges()
        registerBackgroundTask()
        NSLog("[BackgroundLocation] Started significant location monitoring")
    }
    
    /// Stop monitoring location changes
    func stopBackgroundUpdates() {
        locationManager.stopMonitoringSignificantLocationChanges()
        NSLog("[BackgroundLocation] Stopped significant location monitoring")
    }
    
    // MARK: - Background Task Registration
    
    private func registerBackgroundTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: backgroundTaskIdentifier, using: nil) { [weak self] task in
            self?.handleBackgroundTask(task: task as! BGAppRefreshTask)
        }
    }
    
    func scheduleBackgroundTask() {
        let request = BGAppRefreshTaskRequest(identifier: backgroundTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 3600) // 1 hour
        
        do {
            try BGTaskScheduler.shared.submit(request)
            NSLog("[BackgroundLocation] Scheduled background task for 1 hour from now")
        } catch {
            NSLog("[BackgroundLocation] Could not schedule background task: \(error.localizedDescription)")
        }
    }
    
    private func handleBackgroundTask(task: BGAppRefreshTask) {
        // Schedule the next background task
        scheduleBackgroundTask()
        
        // Send current location if available
        if let location = currentLocation {
            Task {
                await sendLocationToOpenClaw(location: location)
            }
        }
        
        task.setTaskCompleted(success: true)
    }
    
    // MARK: - Send Location to OpenClaw
    
    private func sendLocationToOpenClaw(location: CLLocation) async {
        guard isOpenClawConfigured else {
            NSLog("[BackgroundLocation] OpenClaw not configured, skipping location send")
            return
        }
        
        guard let url = URL(string: "\(openClawHost):\(openClawPort)/v1/location") else {
            NSLog("[BackgroundLocation] Invalid OpenClaw URL")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(openClawToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "altitude": location.altitude,
            "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
            "source": "background"
        ]
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await session.data(for: request)
            
            if let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) {
                NSLog("[BackgroundLocation] Location sent successfully: \(location.coordinate.latitude), \(location.coordinate.longitude)")
            } else {
                let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
                NSLog("[BackgroundLocation] Location send failed: \(errorBody)")
            }
        } catch {
            NSLog("[BackgroundLocation] Location send error: \(error.localizedDescription)")
        }
    }
}

// MARK: - CLLocationManagerDelegate

extension BackgroundLocationManager: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        
        currentLocation = location
        NSLog("[BackgroundLocation] Location updated: \(location.coordinate.latitude), \(location.coordinate.longitude)")
        
        // Send location to OpenClaw
        Task {
            await sendLocationToOpenClaw(location: location)
        }
    }
    
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        NSLog("[BackgroundLocation] Authorization changed: \(manager.authorizationStatus.rawValue)")
        
        switch manager.authorizationStatus {
        case .authorizedAlways:
            startBackgroundUpdates()
        case .authorizedWhenInUse:
            NSLog("[BackgroundLocation] When in use only - request always authorization for background")
            locationManager.requestAlwaysAuthorization()
        case .denied, .restricted:
            NSLog("[BackgroundLocation] Location access denied or restricted")
        case .notDetermined:
            break
        @unknown default:
            break
        }
    }
    
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[BackgroundLocation] Location error: \(error.localizedDescription)")
    }
}
