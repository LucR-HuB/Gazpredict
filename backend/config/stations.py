"""Weather station grid configuration for weighted country aggregates."""

WEATHER_GRID = {
    "FR": {
        "temperature_points": [
            {"name": "Paris", "lat": 48.85, "lon": 2.35, "weight": 0.18},
            {"name": "Lille", "lat": 50.63, "lon": 3.06, "weight": 0.07},
            {"name": "Strasbourg", "lat": 48.57, "lon": 7.75, "weight": 0.05},
            {"name": "Nantes", "lat": 47.21, "lon": -1.55, "weight": 0.06},
            {"name": "Bordeaux", "lat": 44.83, "lon": -0.57, "weight": 0.06},
            {"name": "Rennes", "lat": 48.11, "lon": -1.67, "weight": 0.04},
            {"name": "Lyon", "lat": 45.76, "lon": 4.83, "weight": 0.12},
            {"name": "Grenoble", "lat": 45.18, "lon": 5.72, "weight": 0.03},
            {"name": "Marseille", "lat": 43.29, "lon": 5.37, "weight": 0.12},
            {"name": "Toulouse", "lat": 43.60, "lon": 1.44, "weight": 0.08},
            {"name": "Nice", "lat": 43.71, "lon": 7.26, "weight": 0.05},
            {"name": "Montpellier", "lat": 43.61, "lon": 3.87, "weight": 0.04},
        ],
        "wind_points": [
            {"name": "St-Nazaire-Offshore", "lat": 47.16, "lon": -2.50, "weight": 0.25},
            {"name": "Fecamp-Offshore", "lat": 49.90, "lon": 0.20, "weight": 0.15},
            {"name": "St-Brieuc-Offshore", "lat": 48.80, "lon": -2.50, "weight": 0.15},
            {"name": "Champagne-Ardenne", "lat": 49.00, "lon": 4.50, "weight": 0.25},
            {"name": "Hauts-de-France-Wind", "lat": 50.00, "lon": 2.50, "weight": 0.20},
        ],
    },
    "DE": {
        "temperature_points": [
            {"name": "Berlin", "lat": 52.52, "lon": 13.40, "weight": 0.10},
            {"name": "Hamburg", "lat": 53.55, "lon": 9.99, "weight": 0.08},
            {"name": "Munich", "lat": 48.13, "lon": 11.58, "weight": 0.12},
            {"name": "Cologne", "lat": 50.93, "lon": 6.96, "weight": 0.10},
            {"name": "Frankfurt", "lat": 50.11, "lon": 8.68, "weight": 0.08},
            {"name": "Stuttgart", "lat": 48.77, "lon": 9.18, "weight": 0.08},
            {"name": "Dusseldorf", "lat": 51.22, "lon": 6.77, "weight": 0.08},
            {"name": "Leipzig", "lat": 51.33, "lon": 12.37, "weight": 0.06},
            {"name": "Dortmund", "lat": 51.51, "lon": 7.46, "weight": 0.08},
            {"name": "Essen", "lat": 51.45, "lon": 7.01, "weight": 0.08},
            {"name": "Bremen", "lat": 53.07, "lon": 8.80, "weight": 0.05},
            {"name": "Dresden", "lat": 51.05, "lon": 13.73, "weight": 0.05},
            {"name": "Hannover", "lat": 52.37, "lon": 9.73, "weight": 0.04},
        ],
        "wind_points": [
            {"name": "NorthSea_Cluster_1", "lat": 54.50, "lon": 6.50, "weight": 0.30},
            {"name": "NorthSea_Cluster_2", "lat": 55.00, "lon": 7.50, "weight": 0.20},
            {"name": "BalticSea_Cluster", "lat": 54.70, "lon": 13.50, "weight": 0.15},
            {"name": "Schleswig-Holstein-Land", "lat": 54.00, "lon": 9.50, "weight": 0.20},
            {"name": "Brandenburg-Land", "lat": 52.00, "lon": 13.00, "weight": 0.15},
        ],
    },
    "IT": {
        "temperature_points": [
            {"name": "Milan", "lat": 45.46, "lon": 9.19, "weight": 0.25},
            {"name": "Rome", "lat": 41.90, "lon": 12.49, "weight": 0.15},
            {"name": "Turin", "lat": 45.07, "lon": 7.68, "weight": 0.15},
            {"name": "Naples", "lat": 40.85, "lon": 14.26, "weight": 0.10},
            {"name": "Bologna", "lat": 44.49, "lon": 11.34, "weight": 0.08},
            {"name": "Florence", "lat": 43.76, "lon": 11.25, "weight": 0.05},
            {"name": "Venice", "lat": 45.44, "lon": 12.31, "weight": 0.05},
            {"name": "Verona", "lat": 45.43, "lon": 10.99, "weight": 0.05},
            {"name": "Genoa", "lat": 44.40, "lon": 8.94, "weight": 0.05},
            {"name": "Palermo", "lat": 38.11, "lon": 13.36, "weight": 0.04},
            {"name": "Bari", "lat": 41.11, "lon": 16.87, "weight": 0.03},
        ],
        "wind_points": [
            {"name": "Sicily_Channel", "lat": 37.00, "lon": 12.00, "weight": 0.30},
            {"name": "Puglia_Onshore", "lat": 41.00, "lon": 16.00, "weight": 0.40},
            {"name": "Sardinia_West", "lat": 40.00, "lon": 8.50, "weight": 0.30},
        ],
    },
    "NL": {
        "temperature_points": [
            {"name": "Amsterdam", "lat": 52.36, "lon": 4.90, "weight": 0.25},
            {"name": "Rotterdam", "lat": 51.92, "lon": 4.47, "weight": 0.25},
            {"name": "The_Hague", "lat": 52.07, "lon": 4.30, "weight": 0.15},
            {"name": "Utrecht", "lat": 52.09, "lon": 5.12, "weight": 0.15},
            {"name": "Eindhoven", "lat": 51.44, "lon": 5.46, "weight": 0.10},
            {"name": "Groningen", "lat": 53.21, "lon": 6.56, "weight": 0.10},
        ],
        "wind_points": [
            {"name": "Borssele_Offshore", "lat": 51.70, "lon": 3.00, "weight": 0.50},
            {"name": "Hollandse_Kust", "lat": 52.50, "lon": 4.00, "weight": 0.50},
        ],
    },
    "BE": {
        "temperature_points": [
            {"name": "Brussels", "lat": 50.85, "lon": 4.35, "weight": 0.35},
            {"name": "Antwerp", "lat": 51.21, "lon": 4.40, "weight": 0.25},
            {"name": "Ghent", "lat": 51.05, "lon": 3.71, "weight": 0.15},
            {"name": "Charleroi", "lat": 50.41, "lon": 4.44, "weight": 0.10},
            {"name": "Liege", "lat": 50.63, "lon": 5.57, "weight": 0.15},
        ],
        "wind_points": [
            {"name": "NorthSea_BE", "lat": 51.60, "lon": 2.80, "weight": 1.00},
        ],
    },
}

__all__ = ["WEATHER_GRID"]
