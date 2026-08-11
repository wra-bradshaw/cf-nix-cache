//! Rust wire DTOs generated directly from the JSON Schemas.
pub mod api {
    typify::import_types!(schema = "../../schemas/api.json");
}

pub mod manifest {
    typify::import_types!(schema = "../../schemas/manifest.json");
}

pub mod process_job {
    typify::import_types!(schema = "../../schemas/process-job.json");
}

pub mod responses {
    typify::import_types!(schema = "../../schemas/responses.json");
}
