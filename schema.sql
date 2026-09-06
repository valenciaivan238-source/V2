CREATE TABLE IF NOT EXISTS members (
    id SERIAL PRIMARY KEY,
    member_no VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    contact VARCHAR(50),
    loft_name VARCHAR(100),
    address TEXT,
    latitude NUMERIC(10,6),
    longitude NUMERIC(10,6),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL,
    member_id INTEGER REFERENCES members(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pigeons (
    id SERIAL PRIMARY KEY,
    ring_no VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100),
    sex VARCHAR(20),
    color VARCHAR(50),
    birth_year INTEGER,
    status VARCHAR(20) DEFAULT 'Active',
    member_id INTEGER REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS races (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50),
    release_point VARCHAR(150),
    distance_km NUMERIC(10,3),
    race_date DATE,
    release_time TIME,
    entry_fee NUMERIC(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'Open'
);

CREATE TABLE IF NOT EXISTS entries (
    id SERIAL PRIMARY KEY,
    race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
    pigeon_id INTEGER REFERENCES pigeons(id) ON DELETE CASCADE,
    paid BOOLEAN DEFAULT FALSE,
    UNIQUE(race_id,pigeon_id)
);

CREATE TABLE IF NOT EXISTS clockings (
    id SERIAL PRIMARY KEY,
    entry_id INTEGER UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
    arrival_time TIME,
    verified BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS championship_points (
    id SERIAL PRIMARY KEY,
    race_id INTEGER REFERENCES races(id),
    pigeon_id INTEGER REFERENCES pigeons(id),
    rank INTEGER,
    points INTEGER
);

CREATE TABLE IF NOT EXISTS user_sessions (
    sid varchar PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp NOT NULL
);
