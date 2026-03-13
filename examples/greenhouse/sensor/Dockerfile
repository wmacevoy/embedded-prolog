FROM gcc:latest
WORKDIR /app
COPY native/prolog_core.c native/prolog_core.h native/
COPY examples/greenhouse/sensor/main.c .
RUN gcc -O2 -Wall -std=c11 -o sensor main.c native/prolog_core.c -Inative/ -lm
CMD ["./sensor"]
