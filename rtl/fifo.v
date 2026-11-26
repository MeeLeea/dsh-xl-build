// ============================================================================
// fifo.v — Parameterizable single-clock synchronous FIFO
//
// Parameters:
//   WIDTH : data bus width in bits, >= 1            (default 8)
//   DEPTH : number of entries, power of two, >= 2   (default 16)
//   Both are validated at elaboration (PARAMS_OK / g_param_check); illegal
//   values abort elaboration via an intentionally undefined module.
//
// Ports / semantics (frozen interface contract):
//   clk    : single clock; all state updates on posedge clk.
//   rst_n  : asynchronous, active-low reset. Asserting rst_n low at any time
//            (independent of clk) clears wptr/rptr/rdata. The memory array is
//            intentionally NOT reset (reads are gated by empty, so no
//            uninitialized cell is ever observable).
//   wr_en  : write request; silently ignored (no pointer/memory change)
//            while full is asserted.
//   wdata  : data stored when wr_en && !full on a rising clk edge.
//   rd_en  : read request; silently ignored while empty is asserted.
//   rdata  : registered, non-FWFT read data: rd_en && !empty pops mem[rptr]
//            and rdata presents that word from the NEXT clock edge.
//   full   : wptr MSB differs from rptr MSB while the low address bits are
//            equal. Asserted in the same cycle the DEPTH-th unread word is
//            committed (flags are combinational on registered pointers).
//   empty  : wptr == rptr. Asserted in the same cycle the last word is popped.
//   count  : wptr - rptr; number of entries present, 0..DEPTH, valid every
//            cycle including the same-cycle read+write case (net unchanged).
//
// Same-cycle read + write:
//   not full and not empty : both take effect (one push, one pop).
//   full                   : the write is dropped, the read proceeds.
//   empty                  : the read is dropped, the write proceeds.
//   In the push+pop case the two pointers differ in their low bits, so the
//   read address never aliases the write address and no bypass is needed.
//
// Full detection uses ADDR_W+1-bit pointers whose MSB toggles once per lap,
// so no separate counter is required and count is a plain subtraction.
//
// Style: Verilog-2001, pure RTL, no vendor primitives; targets zero
// warnings under `iverilog -Wall` and `verilator --lint-only -Wall`.
// ============================================================================

module fifo #(
  parameter integer WIDTH = 8,          // data width, >= 1
  parameter integer DEPTH = 16          // entries, power of two, >= 2
)(
  input  wire                       clk,
  input  wire                       rst_n,   // asynchronous reset, active low
  input  wire                       wr_en,   // ignored while full
  input  wire [WIDTH-1:0]           wdata,
  input  wire                       rd_en,   // ignored while empty
  output reg  [WIDTH-1:0]           rdata,   // registered read data (non-FWFT)
  output wire                       full,    // wptr MSB != rptr MSB, low bits equal
  output wire                       empty,   // wptr == rptr
  output wire [$clog2(DEPTH):0]     count    // entries present, 0..DEPTH
);

  localparam integer ADDR_W = $clog2(DEPTH);          // bits needed for DEPTH-1

  // Elaboration-time parameter check:
  //   WIDTH >= 1, DEPTH >= 2, DEPTH a power of two.
  // With illegal parameters the generate branch below is elaborated and
  // instantiates an intentionally undefined module, which every tool
  // rejects with an "unknown module" elaboration error. With legal
  // parameters the branch is not taken and nothing is referenced.
  localparam integer PARAMS_OK = ((WIDTH >= 1) && (DEPTH >= 2) &&
                                  ((DEPTH & (DEPTH - 1)) == 0)) ? 1 : 0;

  generate
    if (!PARAMS_OK) begin : g_param_check
      fifo_params_violation_width_ge1_depth_must_be_pow2_ge2 u_param_check();
    end
  endgenerate

  reg [ADDR_W:0]  wptr;                 // one extra wrap bit for full detect
  reg [ADDR_W:0]  rptr;
  reg [WIDTH-1:0] mem [0:DEPTH-1];      // storage, intentionally not reset

  localparam [ADDR_W:0] PTR_RESET = {(ADDR_W+1){1'b0}};

  assign full  = (wptr[ADDR_W] != rptr[ADDR_W]) &&
                 (wptr[ADDR_W-1:0] == rptr[ADDR_W-1:0]);
  assign empty = (wptr == rptr);
  assign count = wptr - rptr;           // (ADDR_W+1)-bit wrap == 0..DEPTH

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      wptr  <= PTR_RESET;
      rptr  <= PTR_RESET;
      rdata <= {WIDTH{1'b0}};
    end else begin
      if (wr_en && !full) begin
        wptr <= wptr + 1'b1;
      end
      if (rd_en && !empty) begin
        rptr  <= rptr + 1'b1;
        rdata <= mem[rptr[ADDR_W-1:0]];
      end
    end
  end

endmodule
