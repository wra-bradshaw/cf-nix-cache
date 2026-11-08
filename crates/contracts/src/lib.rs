pub mod api {
    typify::import_types!(schema = "../../schemas/api.json");
}

pub mod responses {
    typify::import_types!(schema = "../../schemas/responses.json");
}
