server_tokens off;
root /usr/share/nginx/html;
index index.html;
client_max_body_size 1m;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy same-origin always;
add_header X-Frame-Options DENY always;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
location /api/ {
    proxy_pass http://backend:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 5s;
    proxy_read_timeout 70s;
}
location /assets/ { expires 1y; try_files $uri =404; }
location / { expires -1; try_files $uri $uri/ /index.html; }
