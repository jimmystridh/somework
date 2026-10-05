use clap::Parser;
use somework_api::{
    cli::{AdminCommand, Cli, Command, run_admin, run_matrix_crypto},
    config::ServerConfig,
    runner,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn"))).json().init();
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { config } => {
            let cfg = ServerConfig::load(&config)?;
            let runtime = runner::start(cfg).await?;
            tracing::info!(url = %runtime.url(), "SomeWork is serving");
            tokio::signal::ctrl_c().await?;
            tracing::info!("shutting down");
            runtime.stop().await;
        }
        Command::Admin { config, command } => run_admin(&config, command).await?,
        Command::MatrixRegistration { config } => {
            let cfg = ServerConfig::load(&config)?;
            let matrix = cfg.matrix.ok_or_else(|| anyhow::anyhow!("no [matrix] section in the configuration"))?;
            print!("{}", somework_matrix::registration_yaml(&matrix));
        }
        Command::MatrixCrypto { config, command } => run_matrix_crypto(&config, command).await?,
        Command::Backup { config, to } => somework_api::backup::backup(&config, &to).await?,
        Command::Restore { from, to } => somework_api::backup::restore(&from, &to).await?,
    }
    let _ = AdminCommand::VerifyAudit;
    Ok(())
}
